import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseImageKey } from '../src/lib/images';
import { assertRealPath } from './store';
import { processImage, type ProcessedImage } from './images';

/**
 * Private, content-addressed image files next to the workspace snapshot. Nothing here is public until a
 * confirmed publication uploads the images that public articles reference.
 */
export class ImageStore {
  constructor(readonly directory: string) {
    assertRealPath(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private file(key: string) {
    if (!parseImageKey(key)) return undefined;
    const file = path.join(this.directory, key); assertRealPath(file); return file;
  }
  /** Validate, strip metadata and store; re-uploading identical content is a no-op. */
  save(input: Buffer): ProcessedImage {
    const image = processImage(input);
    const file = this.file(image.key)!;
    if (!existsSync(file)) {
      const temporary = path.join(this.directory, '.' + randomUUID() + '.tmp');
      const descriptor = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(descriptor, image.bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      try { renameSync(temporary, file); } finally { if (existsSync(temporary)) rmSync(temporary); }
    }
    return image;
  }
  read(key: string): Buffer | undefined {
    const file = this.file(key);
    return file && existsSync(file) ? readFileSync(file) : undefined;
  }
}
