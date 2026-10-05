import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

const b64u = (b: Buffer) => b.toString('base64url');

/** Signed, expiring token: base64url(json).hmac. Used for onboarding state and checkout return links. */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = b64u(Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = b64u(createHmac('sha256', env('TOKEN_SIGNING_SECRET')).update(body).digest());
  return `${body}.${sig}`;
}
export function verifyToken<T = any>(token: string | null): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env('TOKEN_SIGNING_SECRET')).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload as T;
}
export const nonce = () => b64u(randomBytes(18));

function addressKey(): Buffer {
  const key = Buffer.from(env('ADDRESS_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('ADDRESS_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  return key;
}
/** AES-256-GCM: v1.iv.tag.ciphertext */
export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', addressKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}
export function unseal<T = any>(sealed: string): T {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = createDecipheriv('aes-256-gcm', addressKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}
