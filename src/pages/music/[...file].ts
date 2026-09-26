import type { APIRoute, GetStaticPaths } from 'astro';
import { readFileSync } from 'node:fs';
import { loadMusicCatalog, type MusicAsset } from '../../lib/music';
import { audioResponse } from '../../lib/audio-response';

export const getStaticPaths: GetStaticPaths = () => loadMusicCatalog().assets.map(asset => ({
  params: { file: asset.file }, props: { asset },
}));
export const GET: APIRoute = ({ props, request }) => {
  const asset = props.asset as MusicAsset;
  // Static builds have no request headers. Only dev needs to implement byte ranges.
  return audioResponse(readFileSync(asset.absolutePath), asset.type,
    import.meta.env.DEV ? request.headers.get('range') : null);
};
