import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { passwordHash } from '../workbench/auth';
import { WorkspaceStore } from '../workbench/store';
import { createWorkbenchServer } from '../workbench/http';
const blog = path.resolve(import.meta.dirname, '..');
const root = mkdtempSync(path.join(tmpdir(), 'workbench-browser-'));
const source = path.resolve(blog, '../xan9x-blog-content');
const content = path.join(root, 'content');
cpSync(source, content, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).some(part => part.startsWith('.')) });
const port = Number(process.env.WORKBENCH_TEST_PORT ?? 4325);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const origin = `http://127.0.0.1:${port}`;
const server = createWorkbenchServer({ store: new WorkspaceStore(content, path.join(root, 'private')),
  origin, authMode: process.env.WORKBENCH_TEST_AUTH_MODE, passwordHash: process.env.WORKBENCH_TEST_AUTH_MODE === 'ssh' ? undefined : await passwordHash('test-only-workbench-password'), assets: path.join(blog, 'workbench/dist') });
server.listen(port, '127.0.0.1', () => console.log(`Temporary workbench test fixture: ${origin}; no real content writes; root=${root}`));
const stop = () => { server.closeAllConnections(); server.close(() => { rmSync(root, { recursive: true, force: true }); process.exit(0); }); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
