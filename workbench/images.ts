import { createHash } from 'node:crypto';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, type ImageExtension } from '../src/lib/images';
import { WorkbenchError } from './model';

/**
 * Validate an uploaded image and remove embedded metadata (camera, location, editing history) without
 * re-encoding pixels. Only the JPEG orientation survives, as a minimal EXIF block, so phone photos still
 * display upright. The result is a fixed point: processing it again returns the same bytes and key, which
 * is how the publisher re-verifies what it is about to upload.
 */
export interface ProcessedImage { key: string; extension: ImageExtension; type: string; width: number; height: number; bytes: Buffer }

const invalid = (message = '无法识别的图片文件；只接受 PNG、JPEG、WebP 和 GIF。') => new WorkbenchError(message, 415);
const ascii = (bytes: Buffer, start: number, length: number) => bytes.toString('latin1', start, start + length);

export function processImage(input: Buffer): ProcessedImage {
  if (input.length === 0) throw invalid('图片文件为空。');
  if (input.length > MAX_IMAGE_BYTES) throw new WorkbenchError('单张图片不能超过 8 MiB。', 413);
  const extension = sniff(input);
  let result: { bytes: Buffer; width: number; height: number };
  try { result = { png, jpg: jpeg, webp, gif }[extension](input); }
  catch (error) { if (error instanceof WorkbenchError) throw error; throw invalid('图片文件结构损坏或被截断。'); }
  const { bytes, width, height } = result;
  if (![width, height].every(side => Number.isInteger(side) && side >= 1 && side <= MAX_IMAGE_SIDE)) throw invalid('图片尺寸无效或超过 20000 像素。');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return { key: `${hash}-${width}x${height}.${extension}`, extension, type: IMAGE_TYPES[extension], width, height, bytes };
}
/** The publisher's check: bytes must already be processed and must be the content the key names. */
export function verifyImage(key: string, bytes: Buffer): ProcessedImage {
  const image = processImage(bytes);
  if (image.key !== key || !image.bytes.equals(bytes)) throw new WorkbenchError('图片内容与名称不一致，拒绝上传。', 409);
  return image;
}

function sniff(bytes: Buffer): ImageExtension {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'gif';
  throw invalid();
}
function need(bytes: Buffer, end: number) { if (end > bytes.length) throw new RangeError('truncated'); }

// PNG: drop text, EXIF and timestamp chunks; everything after IEND is discarded.
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
function png(bytes: Buffer) {
  const parts: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8; let width = 0; let height = 0; let ended = false;
  while (!ended) {
    need(bytes, offset + 12);
    const length = bytes.readUInt32BE(offset); const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length; need(bytes, end);
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw new RangeError('no IHDR');
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
    }
    if (!PNG_DROP.has(type)) parts.push(bytes.subarray(offset, end));
    ended = type === 'IEND'; offset = end;
  }
  return { bytes: Buffer.concat(parts), width, height };
}

// JPEG: keep JFIF (APP0), ICC profiles (APP2), Adobe colour (APP14) and image segments; drop the rest of the
// application segments and comments. Scan data is copied as is, and bytes after EOI are discarded.
function jpeg(bytes: Buffer) {
  const parts: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2; let width = 0; let height = 0; let orientation = 1; let insertAt = 1;
  for (;;) {
    need(bytes, offset + 2);
    if (bytes[offset] !== 0xff) throw new RangeError('marker expected');
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; } // Fill byte.
    if (marker === 0xd9) { parts.push(bytes.subarray(offset, offset + 2)); break; }
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) { parts.push(bytes.subarray(offset, offset + 2)); offset += 2; continue; }
    need(bytes, offset + 4);
    const end = offset + 2 + bytes.readUInt16BE(offset + 2); need(bytes, end);
    const segment = bytes.subarray(offset, end); const data = bytes.subarray(offset + 4, end);
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) { need(data, 5); height = data.readUInt16BE(1); width = data.readUInt16BE(3); }
    if (marker === 0xe1 && orientation === 1 && ascii(data, 0, 6) === 'Exif\0\0') orientation = exifOrientation(data.subarray(6));
    const keep = !(marker >= 0xe1 && marker <= 0xef || marker === 0xfe) || marker === 0xee
      || marker === 0xe2 && ascii(data, 0, 12) === 'ICC_PROFILE\0';
    if (keep) { parts.push(segment); if (marker === 0xe0 && parts.length === 2) insertAt = 2; }
    offset = end;
    if (marker === 0xda) { // Entropy-coded data runs to the next marker that is not stuffing or a restart.
      let scan = offset;
      while (scan + 1 < bytes.length && !(bytes[scan] === 0xff && bytes[scan + 1] !== 0x00 && !(bytes[scan + 1]! >= 0xd0 && bytes[scan + 1]! <= 0xd7))) scan++;
      need(bytes, scan + 2); parts.push(bytes.subarray(offset, scan)); offset = scan;
    }
  }
  if (!width || !height) throw new RangeError('no frame');
  if (orientation !== 1) parts.splice(insertAt, 0, orientationSegment(orientation));
  // Orientations 5–8 rotate by 90°: the browser displays the image with its sides swapped.
  return { bytes: Buffer.concat(parts), width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height };
}
function exifOrientation(tiff: Buffer): number {
  try {
    const little = ascii(tiff, 0, 2) === 'II'; if (!little && ascii(tiff, 0, 2) !== 'MM') return 1;
    const u16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
    const u32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
    const ifd = u32(4); const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112 && u16(entry + 2) === 3) { const value = u16(entry + 8); return value >= 1 && value <= 8 ? value : 1; }
    }
  } catch { /* Malformed EXIF is dropped like any other metadata. */ }
  return 1;
}
/** APP1 with a big-endian TIFF header and a single IFD0 entry: Orientation (SHORT). */
function orientationSegment(orientation: number) {
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const data = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]); header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, data]);
}

// WebP: drop EXIF and XMP chunks and clear their VP8X flags.
function webp(bytes: Buffer) {
  need(bytes, 12);
  const end = 8 + bytes.readUInt32LE(4); need(bytes, end);
  const chunks: Buffer[] = []; let offset = 12; let width = 0; let height = 0;
  while (offset < end) {
    need(bytes, offset + 8);
    const type = ascii(bytes, offset, 4); const size = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + size + (size & 1); need(bytes, offset + 8 + size);
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (type === 'VP8X') {
      need(data, 10); width = 1 + data.readUIntLE(4, 3); height = 1 + data.readUIntLE(7, 3);
      const copy = Buffer.from(bytes.subarray(offset, Math.min(next, end))); copy[8] = copy[8]! & ~0x0c; chunks.push(copy);
    } else {
      if (!width && type === 'VP8 ') { need(data, 10); if (data.readUIntBE(3, 3) !== 0x9d012a) throw new RangeError('VP8'); width = data.readUInt16LE(6) & 0x3fff; height = data.readUInt16LE(8) & 0x3fff; }
      if (!width && type === 'VP8L') { need(data, 5); if (data[0] !== 0x2f) throw new RangeError('VP8L'); const bits = data.readUInt32LE(1); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
      if (type !== 'EXIF' && type !== 'XMP ') chunks.push(bytes.subarray(offset, Math.min(next, end)));
    }
    offset = next;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'); header.writeUInt32LE(body.length + 4, 4);
  return { bytes: Buffer.concat([header, body]), width, height };
}

// GIF carries no camera or location metadata; it is kept byte for byte.
function gif(bytes: Buffer) { return { bytes, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }; }
