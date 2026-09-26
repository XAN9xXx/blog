// Run from the blog repository in WSL. All test content stays in a new temp directory.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const blog = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'xan9x-music-browser-'));
const content = path.join(root, 'content');
const site = path.join(root, 'site');
cpSync(path.join(blog, '../xan9x-blog-content'), content, { recursive: true });
mkdirSync(path.join(content, 'music'), { recursive: true });
const samples = 8000 * 6;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
const tracks = ['a', 'b'].map(id => {
  writeFileSync(path.join(content, `music/fixture-${id}.wav`), wav);
  return { id, title: '测试音轨 ' + id.toUpperCase(), artist: '仅用于自动化测试', file: `fixture-${id}.wav` };
});
writeFileSync(path.join(content, 'music/playlist.json'), JSON.stringify({ version: 1, tracks }));
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/assemble.ts'], {
  cwd: blog, stdio: 'inherit', env: { ...process.env, BLOG_CONTENT_SOURCE: content, SITE_DIR: site },
});
console.log(`\nTemporary fixture: ${site}\nRun there:\n  npm ci --offline\n  npm run build\n  npm run dev -- --background --host 0.0.0.0 --port 4324\nAfter testing:\n  npm run dev -- stop`);
