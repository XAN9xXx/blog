import { loadMusicCatalog } from '../src/lib/music';
import { loadContentCatalog } from '../src/lib/content-files';
const { articles, topology } = loadContentCatalog();
console.log('Content validated:', articles.length, 'articles;', Object.keys(topology.articleRefs).length, 'published map entries.');

console.log('Music validated:', loadMusicCatalog().tracks.length, 'tracks.');
