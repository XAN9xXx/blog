import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
const root = new URL('.', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('client.ts', root))], bundle: true, format: 'esm', target: 'es2022', minify: true,
  outfile: fileURLToPath(new URL('dist/app.js', root)), logLevel: 'info' });
await cp(new URL('index.html', root), new URL('dist/index.html', root));
