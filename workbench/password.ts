import { passwordHash } from './auth';
// Read from stdin, not argv (which is visible in process listings). Do not print plaintext.
let password = '';
for await (const chunk of process.stdin) {
  password += chunk.toString(); if (password.length > 1026) throw new Error('密码过长。');
}
console.log(await passwordHash(password.replace(/\r?\n$/, '')));
