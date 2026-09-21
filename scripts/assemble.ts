import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface AssembleConfig {
  blogDir: string;
  contentDir: string;
  siteDir: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const config: AssembleConfig = {
  blogDir: path.resolve(scriptDir, '..'),

  contentDir: path.resolve(
    process.env.BLOG_CONTENT_SOURCE ??
      path.join(scriptDir, '..', '..', 'xan9x-blog-content'),
  ),

  siteDir: path.resolve(
    process.env.SITE_DIR ??
      path.join(scriptDir, '..', '..', 'xan9x-site'),
  ),
};

const excludedBlogEntries = new Set([
  '.git',
  '.astro',
  'dist',
  'node_modules',
]);

function cleanSiteDirectory(): void {
  mkdirSync(config.siteDir, {
    recursive: true,
  });

  for (const entry of readdirSync(config.siteDir)) {
    if (entry === '.git') {
      continue;
    }

    rmSync(path.join(config.siteDir, entry), {
      recursive: true,
      force: true,
    });
  }
}

function copyBlog(): void {
  cpSync(config.blogDir, config.siteDir, {
    recursive: true,

    filter(source) {
      const relative = path.relative(
        config.blogDir,
        source,
      );

      if (!relative) {
        return true;
      }

      const firstEntry = relative.split(path.sep)[0];

      return !excludedBlogEntries.has(firstEntry);
    },
  });
}

function copyContent(): void {
  if (!existsSync(config.contentDir)) {
    throw new Error(
      `Content repository not found: ${config.contentDir}`,
    );
  }

  const destination = path.join(
    config.siteDir,
    'content',
  );

  cpSync(config.contentDir, destination, {
    recursive: true,

    filter(source) {
      const relative = path.relative(
        config.contentDir,
        source,
      );

      if (!relative) {
        return true;
      }

      return relative.split(path.sep)[0] !== '.git';
    },
  });
}

function assemble(): void {
  console.log('Assembling site...');
  console.log();

  cleanSiteDirectory();
  copyBlog();
  copyContent();

  console.log('Site assembled successfully.');
  console.log(`Blog:    ${config.blogDir}`);
  console.log(`Content: ${config.contentDir}`);
  console.log(`Site:    ${config.siteDir}`);
}

assemble();
