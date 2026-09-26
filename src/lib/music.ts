import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { contentDirectory } from './content-files';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const audioTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac',
};
const playlistSchema = z.object({
  version: z.literal(1),
  tracks: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().min(1).max(200).optional(),
    file: z.string().min(1).max(240),
  }).strict()).max(200),
}).strict();
export interface MusicTrack { id: string; title: string; artist?: string; src: string }
export interface MusicAsset { file: string; absolutePath: string; type: string }

export function loadMusicCatalog(directory = contentDirectory()): { tracks: MusicTrack[]; assets: MusicAsset[] } {
  const root = path.join(directory, 'music');
  const manifest = path.join(root, 'playlist.json');
  // A missing manifest is compatible with older content snapshots.
  if (!existsSync(root)) return { tracks: [], assets: [] };
  if (lstatSync(root).isSymbolicLink()) throw new Error('Music symlinks are not supported: ' + root);
  if (!existsSync(manifest)) return { tracks: [], assets: [] };
  if (lstatSync(manifest).isSymbolicLink()) throw new Error('Music symlinks are not supported: ' + manifest);
  const playlist = playlistSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
  const ids = new Set<string>();
  const assets = new Map<string, MusicAsset>();
  const tracks = playlist.tracks.map(track => {
    if (ids.has(track.id)) throw new Error('Duplicate music ID: ' + track.id);
    ids.add(track.id);
    const parts = track.file.split('/');
    if (parts.some(part => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
      throw new Error('Music file must be a relative ASCII path without traversal: ' + track.file);
    }
    const type = audioTypes[path.extname(track.file).toLowerCase()];
    if (!type) throw new Error('Unsupported audio extension: ' + track.file);
    let target = root;
    for (const part of parts) {
      target = path.join(target, part);
      if (!existsSync(target)) throw new Error('Missing music file: ' + track.file);
      if (lstatSync(target).isSymbolicLink()) throw new Error('Music symlinks are not supported: ' + track.file);
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUDIO_BYTES) {
      throw new Error('Music file must be nonempty and at most 25 MiB: ' + track.file);
    }
    assets.set(track.file, { file: track.file, absolutePath: target, type });
    return { id: track.id, title: track.title, ...(track.artist ? { artist: track.artist } : {}), src: '/music/' + track.file };
  });
  return { tracks, assets: [...assets.values()] };
}
