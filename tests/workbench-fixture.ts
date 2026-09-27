import { execFileSync } from 'node:child_process';
import { PublicationReview } from '../workbench/publication-review';
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
let publicationReview: PublicationReview | undefined;
if (process.env.WORKBENCH_TEST_REVIEW === '1') {
  const git = (...args: string[]) => execFileSync('git', ['-C', content, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  publicationReview = new PublicationReview({ repository: content, baseCommit: git('rev-parse', 'HEAD'), visibility: 'private' });
}
const port = Number(process.env.WORKBENCH_TEST_PORT ?? 4325);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const origin = `http://127.0.0.1:${port}`;
const server = createWorkbenchServer({ publicationReview, store: new WorkspaceStore(content, path.join(root, 'private')),
  origin, authMode: process.env.WORKBENCH_TEST_AUTH_MODE, passwordHash: process.env.WORKBENCH_TEST_AUTH_MODE === 'ssh' ? undefined : await passwordHash('test-only-workbench-password'), assets: path.join(blog, 'workbench/dist') });
server.listen(port, '127.0.0.1', () => console.log(`Temporary workbench test fixture: ${origin}; no real content writes; root=${root}`));
const stop = () => { server.closeAllConnections(); server.close(() => { rmSync(root, { recursive: true, force: true }); process.exit(0); }); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
