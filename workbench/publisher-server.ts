import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { PublicationExecutor } from './publication-executor';
import { createPublisherServer } from './publisher-http';
import { cloudflareCredentialSchema, cloudflareLookup, DeploymentReader, githubLookup } from './deployment-reader';
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
// Optional read-only credentials. Never reuse a developer login or expose them to the web service.
function readCredential(file: string) {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error(`Unsafe read credential file: ${file}`);
  return readFileSync(file, 'utf8').trim();
}
const githubToken = readCredential('/etc/xan9x-publisher/github-read-token');
// JSON holding the account ID and a Pages read-only token; the account ID stays out of this public repository.
const cloudflareFile = readCredential('/etc/xan9x-publisher/cloudflare-pages-read');
let cloudflare;
if (cloudflareFile !== undefined) {
  let value: unknown; try { value = JSON.parse(cloudflareFile); } catch { value = undefined; } // JSON errors would echo the file.
  const credential = cloudflareCredentialSchema.safeParse(value);
  if (!credential.success) throw new Error('Invalid Cloudflare read credential file.');
  cloudflare = cloudflareLookup(credential.data);
}
const deployment = new DeploymentReader(githubToken ? { github: githubLookup(githubToken), cloudflare } : undefined);
const server = createPublisherServer(executor, { deployment });
server.listen(socket, () => { chmodSync(socket, 0o660); console.log('Private content executor ready: review only; no push endpoint.'); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
