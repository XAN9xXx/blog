import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { articleSchema, contentId } from './lib/topology-content';
import { contentDirectory, loadContentCatalog } from './lib/content-files';

const contentRoot = contentDirectory();
// Fail before Astro can silently overwrite duplicate IDs or ignore a missing directory.
loadContentCatalog(contentRoot);
const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: contentRoot + '/articles',
    generateId: ({ data }) => contentId.parse(data.id) }),
  schema: articleSchema,
});
export const collections = { articles };
