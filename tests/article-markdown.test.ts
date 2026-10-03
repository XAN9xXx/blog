import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { articleMarkdown } from '../src/lib/article-markdown';

// The same pipeline Astro builds from astro.config.mjs: Shiki, then this plugin, then heading IDs.
const processor = await createSatteriMarkdownProcessor({
  syntaxHighlight: 'shiki',
  shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false },
  hastPlugins: [articleMarkdown],
});
const render = async (markdown: string) => {
  const { code, metadata } = await processor.render(markdown);
  return { html: code, headings: metadata.headings.map(h => [h.depth, h.slug]) };
};

test('a body that uses h1 shifts every heading down so the page title stays the only h1', async () => {
  const { html, headings } = await render('# Hello\n\n## Part\n\n###### Deepest\n');
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /<h2 id="hello">Hello<\/h2>/);
  assert.match(html, /<h3 id="part">Part<\/h3>/);
  assert.match(html, /<h6 id="deepest">Deepest<\/h6>/);
  assert.deepEqual(headings, [[2, 'hello'], [3, 'part'], [6, 'deepest']], 'the table of contents sees the shifted levels');
});

test('bodies that start at h2 keep their levels', async () => {
  const { headings } = await render('## One\n\n### Two\n');
  assert.deepEqual(headings, [[2, 'one'], [3, 'two']]);
});

test('highlighted code blocks gain a language bar and keep both theme colours', async () => {
  const { html } = await render('```bash\nsystemctl status x\n```\n\n```\nplain\n```\n');
  const blocks = html.match(/<figure class="code-block">[\s\S]*?<\/figure>/g) ?? [];
  assert.equal(blocks.length, 2);
  assert.match(blocks[0]!, /^<figure class="code-block"><div class="code-bar"><span class="code-lang">bash<\/span><\/div><pre class="astro-code[^"]*"[^>]*data-language="bash"/);
  assert.match(blocks[0]!, /--shiki-light:#[0-9A-Fa-f]{6};--shiki-dark:#[0-9A-Fa-f]{6}/);
  assert.match(blocks[1]!, /<span class="code-lang"><\/span>/, 'unlabelled blocks keep the bar for the copy button but show no language');
});

test('tables scroll inside a labelled, focusable region', async () => {
  const { html } = await render('| a | b |\n| - | - |\n| 1 | 2 |\n');
  assert.match(html, /<div class="table-scroll" tabindex="0" role="region" aria-label="可横向滚动的表格"><table>/);
});

test('the table region is labelled in the article language', async () => {
  const { code } = await processor.render('| a |\n| - |\n| 1 |\n', { frontmatter: { lang: 'en' } });
  assert.match(code, /aria-label="Scrollable table"/);
});

test('images must be uploaded keys: they get their size from the key and load lazily', async () => {
  const key = 'a'.repeat(32) + '-1200x800.webp';
  const { html } = await render(`![A diagram](https://img.xan9x.com/${key})\n`);
  assert.match(html, new RegExp(`<img src="https://img.xan9x.com/${key}" alt="A diagram" width="1200" height="800" loading="lazy" decoding="async"`));
  for (const src of ['https://evil.example/x.png', '/images/x.png', `https://img.xan9x.com/${key}?v=1`, 'https://img.xan9x.com/' + 'a'.repeat(32) + '-0x800.png', `https://img.xan9x.com.evil.example/${key}`]) {
    await assert.rejects(render(`![x](${src})\n`), /文章图片必须是/, src);
  }
});
