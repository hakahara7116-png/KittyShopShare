import { demoSignInAllowed } from '../lib/auth.js';
import { q } from '../lib/db.js';

const REQUIRED = ['STRIPE_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'TOKEN_SIGNING_SECRET', 'ADDRESS_ENCRYPTION_KEY', 'INTERNAL_TASK_SECRET'];
const AUTH0 = ['AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE'];
const TABLES = ['app_user', 'vendor', 'merchant_connection', 'item', 'group_order', 'cart', 'payment_attempt', 'ledger_entry', 'webhook_event', 'delivery', 'notification'];
const set = (k: string) => !!process.env[k] && process.env[k] !== 'change-me';

/** GET /api/health: what's configured, without revealing any values. */
export async function health() {
  const problems: string[] = [];
  let database: { ok: boolean; missingTables?: string[]; error?: string };
  try {
    const rows = await q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)`, [TABLES]);
    const have = new Set(rows.map(r => r.table_name));
    const missing = TABLES.filter(t => !have.has(t));
    database = missing.length ? { ok: false, missingTables: missing } : { ok: true };
    if (missing.length) problems.push(`Database tables are missing (${missing.join(', ')}). The migrations in netlify/database/migrations haven't been applied: redeploy, and check the deploy log for the database step.`);
  } catch (e: any) {
    database = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
    problems.push('Kitty can’t reach the database. Make sure Netlify Database is enabled for this project (it’s provisioned when @netlify/database is in package.json and the site deploys).');
  }
  const missingEnv = REQUIRED.filter(k => !set(k));
  if (missingEnv.length) problems.push(`Environment variables not set: ${missingEnv.join(', ')}. Add them under Project configuration → Environment variables, then redeploy.`);
  const key = process.env.ADDRESS_ENCRYPTION_KEY;
  if (key && key !== 'change-me' && Buffer.from(key, 'base64').length !== 32) problems.push('ADDRESS_ENCRYPTION_KEY must be 32 random bytes in base64 (generate with: openssl rand -base64 32).');
  const demo = demoSignInAllowed();
  const auth0 = AUTH0.every(set);
  if (!demo && !auth0) problems.push('No sign-in is configured. Either set the Auth0 variables (AUTH_JWKS_URL, AUTH_ISSUER, AUTH_AUDIENCE), or for testing set DEMO_AUTH=true.');
  if (process.env.DEMO_AUTH === 'true' && (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_')) problems.push('DEMO_AUTH is ignored because a live Stripe key is set. Use Auth0 for live payments.');
  return {
    ok: problems.length === 0,
    problems,
    database,
    signIn: { demo, auth0 },
    stripe: { keySet: set('STRIPE_SECRET_KEY'), mode: (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_') ? 'live' : 'test', webhookSecretSet: set('STRIPE_CONNECT_WEBHOOK_SECRET') },
    optional: { couriers: { doordash: !!process.env.DOORDASH_DEVELOPER_ID, uber: !!process.env.UBER_DIRECT_CUSTOMER_ID }, postalCodeSearch: !!process.env.MAPBOX_TOKEN },
  };
}
