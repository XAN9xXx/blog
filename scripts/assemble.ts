import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface AssembleConfig {
  blogDir: string;
  contentDir: string;
  siteDir: string;
}

interface RepositoryProvenance {
  commit: string;
  dirty: boolean;
}

interface BuildProvenance {
  blog: RepositoryProvenance;
  content: RepositoryProvenance;
  assembledAt: string;
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

function runGit(
  repository: string,
  args: string[],
): string {
  return execFileSync(
    'git',
    ['-C', repository, ...args],
    {
      encoding: 'utf8',
    },
  ).trim();
}

function getRepositoryProvenance(
  repository: string,
): RepositoryProvenance {
  const commit = runGit(
    repository,
    ['rev-parse', 'HEAD'],
  );

  const status = runGit(
    repository,
    ['status', '--porcelain'],
  );

  return {
    commit,
    dirty: status.length > 0,
  };
}

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

function writeProvenance(
  provenance: BuildProvenance,
): void {
  const output = path.join(
    config.siteDir,
    '.site-build.json',
  );

  writeFileSync(
    output,
    `${JSON.stringify(provenance, null, 2)}\n`,
    'utf8',
  );
}

function assemble(): void {
  console.log('Assembling site...');
  console.log();

  const provenance: BuildProvenance = {
    blog: getRepositoryProvenance(config.blogDir),
    content: getRepositoryProvenance(config.contentDir),
    assembledAt: new Date().toISOString(),
  };

  cleanSiteDirectory();
  copyBlog();
  copyContent();
  writeProvenance(provenance);

  console.log('Site assembled successfully.');
  console.log(`Blog:    ${config.blogDir}`);
  console.log(`Content: ${config.contentDir}`);
  console.log(`Site:    ${config.siteDir}`);

  console.log();
  console.log(`Blog commit:    ${provenance.blog.commit}`);
  console.log(`Content commit: ${provenance.content.commit}`);

  if (provenance.blog.dirty) {
    console.warn('Warning: Blog repository has uncommitted changes.');
  }

  if (provenance.content.dirty) {
    console.warn('Warning: Content repository has uncommitted changes.');
  }
}

assemble();
