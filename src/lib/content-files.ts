import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { articleSchema, compilePublicTopology, type ArticleRecord } from './topology-content';

export function contentDirectory(): string {
  return path.resolve(process.env.BLOG_CONTENT_DIR ?? (existsSync('content/topology.json') ? './content' : '../xan9x-blog-content'));
}
export interface ArticleFile extends ArticleRecord { relativePath: string; raw: string }
export function loadContentCatalog(directory = contentDirectory()) {
  const articles: ArticleFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Content symlinks are not supported: ' + file);
      if (name.startsWith('.')) continue;
      if (stat.isDirectory()) walk(file);
      else if (name.endsWith('.md')) {
        const raw = readFileSync(file, 'utf8');
        // gray-matter also supports executable JS frontmatter: accept YAML fences only.
        if (!/^\uFEFF?---[ \t]*\r?\n/.test(raw) || !/\r?\n---[ \t]*(?:\r?\n|$)/.test(raw)) {
          throw new Error('Articles require fenced YAML frontmatter: ' + file);
        }
        const data = articleSchema.parse(matter(raw, { language: 'yaml' }).data);
        articles.push({ id: data.id, data, relativePath: path.relative(directory, file), raw });
      }
    }
  };
  walk(path.join(directory, 'articles'));
  const input: unknown = JSON.parse(readFileSync(path.join(directory, 'topology.json'), 'utf8'));
  const topology = compilePublicTopology(input, articles);
  return { articles, topology };
}
