import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMusicCatalog, MAX_AUDIO_BYTES } from '../src/lib/music';
import { audioResponse } from '../src/lib/audio-response';

function setup(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'xan9x-music-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'music'));
  writeFileSync(path.join(directory, 'music/example.mp3'), 'audio fixture');
  const save = (tracks: unknown[]) => writeFileSync(path.join(directory, 'music/playlist.json'), JSON.stringify({ version: 1, tracks }));
  return { directory, save };
}
const track = { id: 'one', title: '真实标题', artist: '音乐人', file: 'example.mp3' };
test('missing and empty playlists are honest empty states', t => {
  const f = setup(t); assert.deepEqual(loadMusicCatalog(f.directory), { tracks: [], assets: [] });
  f.save([]); assert.deepEqual(loadMusicCatalog(f.directory), { tracks: [], assets: [] });
});
test('only referenced local files are exposed; shared files are emitted once', t => {
  const f = setup(t); f.save([track, { ...track, id: 'two', title: '<script>not code</script>' }]);
  writeFileSync(path.join(f.directory, 'music/unlisted.mp3'), 'unlisted');
  const catalog = loadMusicCatalog(f.directory);
  assert.equal(catalog.assets.length, 1); assert.equal(catalog.assets[0]!.type, 'audio/mpeg');
  assert.equal(catalog.tracks[0]!.src, '/music/example.mp3');
  assert.equal(catalog.tracks[1]!.title, '<script>not code</script>');
  assert.ok(!JSON.stringify(catalog.tracks).includes(f.directory));
});
for (const file of ['../example.mp3', '/example.mp3', 'https://example.com/a.mp3', 'a\\b.mp3', '%2e%2e/a.mp3', '.hidden.mp3', 'a/../b.mp3', 'example.mp3?x', 'example.svg']) {
  test('rejects unsafe or unsupported music path ' + file, t => {
    const f = setup(t); f.save([{ ...track, file }]); assert.throws(() => loadMusicCatalog(f.directory), /relative ASCII|Unsupported audio/);
  });
}
test('invalid JSON, schema and duplicate IDs fail instead of hiding errors', t => {
  const f = setup(t);
  f.save([track, track]); assert.throws(() => loadMusicCatalog(f.directory), /Duplicate music ID/);
  f.save([{ ...track, url: 'https://example.com' }]); assert.throws(() => loadMusicCatalog(f.directory));
  f.save([{ ...track, title: '  ' }]); assert.throws(() => loadMusicCatalog(f.directory));
  writeFileSync(path.join(f.directory, 'music/playlist.json'), '{'); assert.throws(() => loadMusicCatalog(f.directory));
});
test('missing, empty, and over-limit audio files fail early', t => {
  const f = setup(t); f.save([{ ...track, file: 'missing.mp3' }]); assert.throws(() => loadMusicCatalog(f.directory), /Missing music/);
  f.save([track]); const file = path.join(f.directory, 'music/example.mp3');
  truncateSync(file, 0); assert.throws(() => loadMusicCatalog(f.directory), /nonempty/);
  truncateSync(file, MAX_AUDIO_BYTES + 1); assert.throws(() => loadMusicCatalog(f.directory), /25 MiB/);
});
test('rejects symlink files, ancestors, and manifest', { skip: process.platform === 'win32' }, t => {
  const f = setup(t); symlinkSync('example.mp3', path.join(f.directory, 'music/link.mp3'));
  f.save([{ ...track, file: 'link.mp3' }]); assert.throws(() => loadMusicCatalog(f.directory), /symlinks/);
  symlinkSync('.', path.join(f.directory, 'music/alias'));
  f.save([{ ...track, file: 'alias/example.mp3' }]); assert.throws(() => loadMusicCatalog(f.directory), /symlinks/);
  rmSync(path.join(f.directory, 'music/playlist.json'));
  symlinkSync('example.mp3', path.join(f.directory, 'music/playlist.json'));
  assert.throws(() => loadMusicCatalog(f.directory), /symlinks/);
});
test('static audio and development byte ranges preserve bytes and headers', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  const full = audioResponse(bytes, 'audio/wav'); assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '5'); assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  for (const [range, expected] of [['bytes=1-2', [1, 2]], ['bytes=3-', [3, 4]], ['bytes=-2', [3, 4]], ['bytes=2-99', [2, 3, 4]]] as const) {
    const response = audioResponse(bytes, 'audio/wav', range);
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
  }
  for (const range of ['bytes=5-', 'bytes=3-1', 'bytes=-0', 'bytes=-', 'invalid', 'bytes=0-1,3-4']) {
    const response = audioResponse(bytes, 'audio/wav', range); assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */5');
  }
});
