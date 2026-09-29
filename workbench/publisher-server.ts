import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { PublicationExecutor } from './publication-executor';
import { createPublisherServer } from './publisher-http';
import { DeploymentReader, githubLookup } from './deployment-reader';
// Administrator-owned constants: no URL, shell command or key path can come from the browser.
// There is deliberately no environment switch or HTTP route enabling the first real push.
const socket = '/run/xan9x-publisher/review.sock';
// The Git host address stays out of this public repository: a root-owned SSH config on
// the server maps the content-origin alias to the RainYun host and port.
const sshConfig = '/etc/xan9x-publisher/ssh_config';
if (!existsSync(sshConfig)) throw new Error(`Missing ${sshConfig}; define Host content-origin before starting.`);
if (existsSync(socket)) throw new Error('Publisher socket already exists; inspect the previous service before recovery.');
const executor = new PublicationExecutor({
  directory: '/var/lib/xan9x-publisher/state',
  remote: 'ssh://git@content-origin/srv/git/xan9x-blog-content.git',
  sshCommand: `ssh -F ${sshConfig} -i /var/lib/xan9x-publisher/.ssh/content_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/xan9x-publisher/.ssh/known_hosts -o ConnectTimeout=10`,
  publishEnabled: false,
});
// Optional read-only credential. Never reuse a developer login or expose it to the web service.
const tokenFile = '/etc/xan9x-publisher/github-read-token';
let deployment = new DeploymentReader();
if (existsSync(tokenFile)) {
  const stat = lstatSync(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error('Unsafe GitHub read credential file.');
  deployment = new DeploymentReader(githubLookup(readFileSync(tokenFile, 'utf8').trim()));
}
const server = createPublisherServer(executor, { deployment });
server.listen(socket, () => { chmodSync(socket, 0o660); console.log('Private content executor ready: review only; no push endpoint.'); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
