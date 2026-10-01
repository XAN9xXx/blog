// @ts-check
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import { articleMarkdown } from './src/lib/article-markdown.ts';

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  markdown: {
    processor: satteri({ hastPlugins: [articleMarkdown] }),
    // Both themes are emitted as CSS variables; prose.css picks one from the page's data-theme.
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false },
  },
});
