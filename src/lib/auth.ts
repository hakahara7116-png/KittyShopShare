import { createRemoteJWKSet, jwtVerify } from 'jose';
import { one } from './db.js';
import { env, isLocalDev } from './env.js';
import { HttpError } from './http.js';

export interface User { id: string; name: string | null; email: string | null }
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Verifies the bearer token (Auth0, Clerk or any OIDC issuer with a JWKS) and upserts the user. */
export async function requireUser(req: Request): Promise<User> {
  const devUser = req.headers.get('x-dev-user');
  if (devUser && demoSignInAllowed()) {
    const name = devUser.slice(0, 40);
    return upsert('dev|' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), null, name);
  }
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Sign in first.');
  jwks ??= createRemoteJWKSet(new URL(env('AUTH_JWKS_URL')));
  try {
    const { payload } = await jwtVerify(h.slice(7), jwks, { issuer: env('AUTH_ISSUER'), audience: env('AUTH_AUDIENCE') });
    if (!payload.sub) throw new Error('no sub');
    const email = typeof payload.email === 'string' ? payload.email : null;
    const name = typeof payload.name === 'string' ? payload.name : null;
    return upsert(payload.sub, email, name);
  } catch {
    throw new HttpError(401, 'Your session expired. Sign in again.');
  }
}
async function upsert(id: string, email: string | null, name: string | null): Promise<User> {
  const row = await one<User>(
    `INSERT INTO app_user (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET email = COALESCE(EXCLUDED.email, app_user.email),
       name = COALESCE(app_user.name, EXCLUDED.name), updated_at = now()
     RETURNING id, name, email`, [id, email, name]);
  return row!;
}

/**
 * Name-only sign-in, no password. Allowed under `netlify dev` with DEV_AUTH=true, or on a deployed site
 * only when DEMO_AUTH=true is set explicitly. Anyone can act as anyone: never enable it with live payments.
 */
export function demoSignInAllowed(): boolean {
  if (isLocalDev() && process.env.DEV_AUTH === 'true') return true;
  return process.env.DEMO_AUTH === 'true' && !(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_');
}
