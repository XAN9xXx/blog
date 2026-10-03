/**
 * Article images live in R2 behind IMAGE_ORIGIN, never in Git. A key names its content and its display size:
 * `<first 32 hex of SHA-256>-<width>x<height>.<ext>`, so a URL never changes meaning and the site can set
 * width/height without fetching the file.
 */
export const IMAGE_ORIGIN = 'https://img.xan9x.com';
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const;
export type ImageExtension = keyof typeof IMAGE_TYPES;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 20_000;
const KEY = /^([a-f0-9]{32})-([1-9][0-9]{0,4})x([1-9][0-9]{0,4})\.(png|jpg|webp|gif)$/;

export interface ImageKey { key: string; hash: string; width: number; height: number; extension: ImageExtension }
export function parseImageKey(key: string): ImageKey | undefined {
  const match = KEY.exec(key);
  if (!match) return undefined;
  const width = Number(match[2]); const height = Number(match[3]);
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return undefined;
  return { key, hash: match[1]!, width, height, extension: match[4] as ImageExtension };
}
/** Only an exact IMAGE_ORIGIN/<key> URL counts: no query, fragment, credentials or other path. */
export function parseImageUrl(url: string): ImageKey | undefined {
  if (!url.startsWith(IMAGE_ORIGIN + '/')) return undefined;
  return parseImageKey(url.slice(IMAGE_ORIGIN.length + 1));
}
export const imageUrl = (key: string) => `${IMAGE_ORIGIN}/${key}`;
