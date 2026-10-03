import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processImage, verifyImage } from '../workbench/images';
import { parseImageKey, parseImageUrl } from '../src/lib/images';

// Hand-built files: the processor reads structure, never pixels, so synthetic scan data is enough.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pngChunk = (type: string, data: string) => {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length, 0); header.write(type, 4, 'latin1');
  return Buffer.concat([header, Buffer.from(data, 'latin1'), Buffer.alloc(4)]);
};
const segment = (marker: number, data: Buffer) => {
  const header = Buffer.from([0xff, marker, 0, 0]); header.writeUInt16BE(data.length + 2, 2); return Buffer.concat([header, data]);
};
function exif(orientation: number) {
  // Little-endian TIFF: IFD0 with Orientation plus a GPS pointer, and a fake location string after it.
  const tiff = Buffer.alloc(64); tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(40, 30);
  tiff.write('GPS-31.2304N', 40, 'latin1');
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}
function jpeg(orientation: number, withJfif = true) {
  const sof = Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0]); // 8-bit, height 2, width 3, one component.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    withJfif ? segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')) : Buffer.alloc(0),
    segment(0xe1, exif(orientation)),
    segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS-XMP</x:xmpmeta>', 'latin1')),
    segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01colour', 'latin1')),
    segment(0xed, Buffer.from('Photoshop 3.0\0IPTC-City', 'latin1')),
    segment(0xfe, Buffer.from('comment-secret', 'latin1')),
    segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), // Stuffed 0xFF and a restart marker inside the scan.
    Buffer.from([0xff, 0xd9]),
    Buffer.from('trailing-after-EOI', 'latin1'),
  ]);
}
function webp() {
  const chunk = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8); header.write(type, 0, 'latin1'); header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
  };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04 | 0x10; vp8x.writeUIntLE(639, 4, 3); vp8x.writeUIntLE(479, 7, 3);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE((639) | (479 << 14), 1);
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', vp8l), chunk('EXIF', Buffer.from('GPS-webp')), chunk('XMP ', Buffer.from('xmp!'))]);
  const header = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'); header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}

test('PNG: text, EXIF and timestamp chunks are removed; the key names the stripped content and size', () => {
  const iend = PNG_1X1.length - 12;
  const input = Buffer.concat([PNG_1X1.subarray(0, iend), pngChunk('tEXt', 'Author\0secret'), pngChunk('eXIf', 'GPS'), PNG_1X1.subarray(iend), Buffer.from('junk')]);
  const image = processImage(input);
  assert.deepEqual(image.bytes, PNG_1X1);
  assert.equal(image.key, createHash('sha256').update(PNG_1X1).digest('hex').slice(0, 32) + '-1x1.png');
  assert.equal(image.type, 'image/png');
  assert.deepEqual(parseImageKey(image.key), { key: image.key, hash: image.key.slice(0, 32), width: 1, height: 1, extension: 'png' });
  assert.equal(verifyImage(image.key, image.bytes).key, image.key);
});

test('JPEG: metadata and trailers go, ICC stays, and orientation survives as a minimal EXIF block', () => {
  for (const withJfif of [true, false]) {
    const image = processImage(jpeg(6, withJfif));
    const text = image.bytes.toString('latin1');
    for (const secret of ['GPS', 'IPTC', 'comment-secret', 'trailing-after-EOI', 'xmpmeta']) assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes('ICC_PROFILE'));
    assert.match(image.key, /-2x3\.jpg$/, 'orientation 6 rotates 90°, so the displayed size swaps');
    assert.deepEqual(processImage(image.bytes).bytes, image.bytes, 'processing is a fixed point');
    assert.equal(image.bytes.indexOf(Buffer.from('Exif\0\0', 'latin1')), withJfif ? 24 : 6, 'the orientation block follows SOI (and JFIF)');
    assert.deepEqual(image.bytes.subarray(-2), Buffer.from([0xff, 0xd9]));
  }
  const upright = processImage(jpeg(1));
  assert.match(upright.key, /-3x2\.jpg$/);
  assert.ok(!upright.bytes.includes(Buffer.from('Exif', 'latin1')), 'no EXIF block at all when no rotation is needed');
});

test('WebP: EXIF and XMP chunks and their flags are removed; GIF is kept as is', () => {
  const image = processImage(webp());
  assert.match(image.key, /-640x480\.webp$/);
  assert.ok(!image.bytes.includes(Buffer.from('GPS')) && !image.bytes.includes(Buffer.from('xmp!')));
  assert.equal(image.bytes[20]! & 0x0c, 0, 'VP8X no longer announces EXIF or XMP');
  assert.equal(image.bytes[20]! & 0x10, 0x10, 'other flags are untouched');
  assert.equal(image.bytes.readUInt32LE(4), image.bytes.length - 8);
  assert.deepEqual(processImage(image.bytes).bytes, image.bytes);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([5, 0, 7, 0]), Buffer.alloc(8)]);
  assert.match(processImage(gif).key, /-5x7\.gif$/);
});

test('anything else is refused: other formats, damage, oversize, and content that does not match its key', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('not an image'), PNG_1X1.subarray(0, 30), jpeg(1).subarray(0, 40)]) {
    assert.throws(() => processImage(bytes), (error: { status?: number }) => error.status === 415);
  }
  assert.throws(() => processImage(Buffer.concat([PNG_1X1, Buffer.alloc(8 * 1024 * 1024)])), /8 MiB/);
  const zero = Buffer.from(PNG_1X1); zero.writeUInt32BE(0, 16);
  assert.throws(() => processImage(zero), /尺寸/);
  const image = processImage(PNG_1X1);
  assert.throws(() => verifyImage(image.key.replace(/^./, image.key[0] === 'a' ? 'b' : 'a'), image.bytes), /不一致/);
  assert.throws(() => verifyImage(processImage(jpeg(6)).key, jpeg(6)), /不一致/, 'unprocessed bytes are refused even with the right key');
});

test('image URLs are exact: origin, key shape and size bounds', () => {
  const key = 'f'.repeat(32) + '-20000x1.gif';
  assert.equal(parseImageUrl('https://img.xan9x.com/' + key)?.width, 20000);
  for (const url of ['http://img.xan9x.com/' + key, 'https://img.xan9x.com/' + key + '#x', 'https://img.xan9x.com/a/' + key,
    'https://img.xan9x.com/' + 'f'.repeat(32) + '-20001x1.gif', 'https://img.xan9x.com/' + 'F'.repeat(32) + '-1x1.gif', 'https://img.xan9x.com/' + 'f'.repeat(32) + '-1x1.svg']) {
    assert.equal(parseImageUrl(url), undefined, url);
  }
});
