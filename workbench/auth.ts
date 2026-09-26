import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { WorkbenchError } from './model';
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key));
});
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 1024) throw new Error('密码长度应为 12–1024 个字符。');
  const salt = randomBytes(24).toString('hex');
  return 'scrypt$' + salt + '$' + (await derive(password, salt)).toString('hex');
}
/** Both access modes retain an opaque session and synchronizer CSRF token. */
export class Sessions {
  private sessions = new Map<string, { csrf: string; expires: number; touched: number }>();
  constructor(protected clock = () => Date.now()) {}
  createSession() {
    const now = this.clock();
    for (const [id, session] of this.sessions) if (session.expires <= now || now - session.touched > 60 * 60_000) this.sessions.delete(id);
    if (this.sessions.size >= 16) this.sessions.delete(this.sessions.keys().next().value!);
    const id = randomBytes(32).toString('hex');
    const session = { csrf: randomBytes(32).toString('hex'), expires: now + 8 * 60 * 60_000, touched: now };
    this.sessions.set(id, session); return { id, csrf: session.csrf };
  }
  session(cookie = '') {
    const id = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('workbench_session='))?.slice(18);
    const session = id ? this.sessions.get(id) : undefined;
    const now = this.clock();
    if (!session || session.expires <= now || now - session.touched > 60 * 60_000) {
      if (id) this.sessions.delete(id); throw new WorkbenchError('请登录工作台。', 401);
    }
    session.touched = now; return { id: id!, ...session };
  }
  logout(id: string) { this.sessions.delete(id); }
}
export class Auth extends Sessions {
  private attempts: number[] = [];
  private authenticating = false;
  private salt: string;
  private key: Buffer;
  constructor(hash: string, clock = () => Date.now()) {
    super(clock);
    if (!/^scrypt\$[a-f0-9]{48}\$[a-f0-9]{128}$/.test(hash)) throw new Error('必须配置有效的 WORKBENCH_PASSWORD_HASH。');
    const [, salt, key] = hash.split('$'); this.salt = salt!; this.key = Buffer.from(key!, 'hex');
  }
  async login(password: unknown) {
    if (this.authenticating) throw new WorkbenchError('正在验证登录，请稍后重试。', 429);
    this.authenticating = true;
    try {
      const now = this.clock();
      this.attempts = this.attempts.filter(time => now - time < 15 * 60_000);
      if (this.attempts.length >= 10) throw new WorkbenchError('登录尝试过多，请在 15 分钟后重试。', 429);
      this.attempts.push(now);
      if (typeof password !== 'string' || password.length > 1024 || !timingSafeEqual(await derive(password, this.salt), this.key)) throw new WorkbenchError('密码错误。', 401);
      return this.createSession();
    } finally { this.authenticating = false; }
  }
}
