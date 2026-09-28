import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createPublisherServer } from '../workbench/publisher-http';
import { PublisherReview } from '../workbench/publisher-client';
import { PublicationExecutor } from '../workbench/publication-executor';
import { PublicationReview, type PublicationReviewProvider } from '../workbench/publication-review';
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
let publicationReview: PublicationReviewProvider | undefined;
let publisherServer: ReturnType<typeof createPublisherServer> | undefined;
if (process.env.WORKBENCH_TEST_REVIEW === '1' || process.env.WORKBENCH_TEST_PUBLISH === '1') {
  const git = (...args: string[]) => execFileSync('git', ['-C', content, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  if (process.env.WORKBENCH_TEST_PUBLISH === '1') {
    // Test-only local bare remote inside this freshly-created temporary root; no real SSH credentials.
    const remote = path.join(root, 'remote.git'); git('clone', '--bare', content, remote);
    const executor = new PublicationExecutor({ directory: path.join(root, 'publisher'), remote, publishEnabled: true });
    publisherServer = createPublisherServer(executor, { allowConfirmation: true });
    const socket = path.join(root, 'publisher.sock'); publisherServer.listen(socket); await once(publisherServer, 'listening');
    publicationReview = new PublisherReview(socket, { allowConfirmation: true });
  } else publicationReview = new PublicationReview({ repository: content, baseCommit: git('rev-parse', 'HEAD'), visibility: 'private' });
}
const port = Number(process.env.WORKBENCH_TEST_PORT ?? 4325);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const origin = `http://127.0.0.1:${port}`;
const server = createWorkbenchServer({ publicationReview, store: new WorkspaceStore(content, path.join(root, 'private')),
  origin, authMode: process.env.WORKBENCH_TEST_AUTH_MODE, passwordHash: process.env.WORKBENCH_TEST_AUTH_MODE === 'ssh' ? undefined : await passwordHash('test-only-workbench-password'), assets: path.join(blog, 'workbench/dist') });
server.listen(port, '127.0.0.1', () => console.log(`Temporary workbench test fixture: ${origin}; no real content writes; root=${root}`));
const stop = async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (publisherServer) { publisherServer.closeAllConnections(); await new Promise<void>(resolve => publisherServer!.close(() => resolve())); }
  rmSync(root, { recursive: true, force: true }); process.exit(0);
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
