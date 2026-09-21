import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const contentRoot =
  process.env.BLOG_CONTENT_DIR ??
  '../xan9x-blog-content';

const articles = defineCollection({
  loader: glob({
    pattern: '**/*.md',
    base: `${contentRoot}/articles`,
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    draft: z.boolean().default(false),
  }),
});

export const collections = {
  articles,
};
