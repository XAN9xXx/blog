import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
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
  '.github',
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

function assertDirectory(
  directory: string,
  description: string,
): void {
  if (!existsSync(directory)) {
    throw new Error(
      `${description} does not exist: ${directory}`,
    );
  }

  if (!statSync(directory).isDirectory()) {
    throw new Error(
      `${description} is not a directory: ${directory}`,
    );
  }
}

function assertFile(
  file: string,
  description: string,
): void {
  if (!existsSync(file)) {
    throw new Error(
      `${description} does not exist: ${file}`,
    );
  }

  if (!statSync(file).isFile()) {
    throw new Error(
      `${description} is not a file: ${file}`,
    );
  }
}

function assertGitRepository(
  repository: string,
  description: string,
): void {
  try {
    const result = runGit(
      repository,
      ['rev-parse', '--is-inside-work-tree'],
    );

    if (result !== 'true') {
      throw new Error();
    }
  } catch {
    throw new Error(
      `${description} is not a Git working tree: ${repository}`,
    );
  }
}

function assertSafeSiteDirectory(): void {
  const { blogDir, contentDir, siteDir } = config;

  if (
    siteDir === blogDir ||
    siteDir === contentDir
  ) {
    throw new Error(
      'Site directory must not be the Blog or Content repository.',
    );
  }

  if (
    siteDir.startsWith(`${blogDir}${path.sep}`) ||
    siteDir.startsWith(`${contentDir}${path.sep}`)
  ) {
    throw new Error(
      'Site directory must not be inside the Blog or Content repository.',
    );
  }

  if (
    blogDir.startsWith(`${siteDir}${path.sep}`) ||
    contentDir.startsWith(`${siteDir}${path.sep}`)
  ) {
    throw new Error(
      'Site directory must not contain the Blog or Content repository.',
    );
  }
}

function preflight(): void {
  console.log('Running preflight checks...');

  assertDirectory(
    config.blogDir,
    'Blog repository',
  );

  assertDirectory(
    config.contentDir,
    'Content repository',
  );

  assertGitRepository(
    config.blogDir,
    'Blog repository',
  );

  assertGitRepository(
    config.contentDir,
    'Content repository',
  );

  assertFile(
    path.join(config.blogDir, 'package.json'),
    'Blog package.json',
  );

  assertFile(
    path.join(config.blogDir, 'package-lock.json'),
    'Blog package-lock.json',
  );

  assertDirectory(
    path.join(config.contentDir, 'articles'),
    'Content articles directory',
  );

  assertSafeSiteDirectory();

  console.log('Preflight checks passed.');
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
  preflight();

  console.log();
  console.log('Assembling site...');
  console.log();

  const provenance: BuildProvenance = {
    blog: getRepositoryProvenance(config.blogDir),
    content: getRepositoryProvenance(config.contentDir),
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
    console.warn(
      'Warning: Blog repository has uncommitted changes.',
    );
  }

  if (provenance.content.dirty) {
    console.warn(
      'Warning: Content repository has uncommitted changes.',
    );
  }
}

assemble();
