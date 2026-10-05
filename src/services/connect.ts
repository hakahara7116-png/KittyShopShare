import type { User } from '../lib/auth.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { one, q } from '../lib/db.js';
import { feeBps } from '../lib/env.js';
import { assert, HttpError } from '../lib/http.js';
import { provider } from '../lib/providers/index.js';
import { cancelGroup } from './groups.js';

interface State { v: string; c: string; p: string }

/** POST /api/connect/:provider/start: creates (or reuses) the merchant account and returns the provider's onboarding URL. */
export async function startOnboarding(user: User, providerKey: string, origin: string) {
  const p = provider(providerKey);
  const vendor = await one(`SELECT * FROM vendor WHERE owner_id = $1`, [user.id]);
  assert(vendor, 409, 'Open your shop first.');
  let conn = await one(`SELECT * FROM merchant_connection WHERE vendor_id = $1 AND status <> 'disconnected'`, [vendor.id]);
  if (conn && conn.provider !== providerKey) {
    assert(!['active', 'pending'].includes(conn.status), 409, 'Disconnect your current merchant account before switching providers.');
    await q(`UPDATE merchant_connection SET status = 'disconnected', updated_at = now() WHERE id = $1`, [conn.id]);
    conn = null;
  }
  conn ??= await one(`INSERT INTO merchant_connection (vendor_id, provider, status, fee_bps) VALUES ($1, $2, 'onboarding', $3) RETURNING *`, [vendor.id, providerKey, feeBps()]);
  const state = signToken({ v: vendor.id, c: conn.id, p: providerKey }, 60 * 60);
  const link = await p.createOnboardingLink({
    existingAccountId: conn.provider_account_id, businessName: vendor.name, vendorId: vendor.id,
    returnUrl: `${origin}/api/connect/callback?state=${encodeURIComponent(state)}`,
    refreshUrl: `${origin}/api/connect/refresh?state=${encodeURIComponent(state)}`,
  });
  await q(`UPDATE merchant_connection SET provider_account_id = $2, updated_at = now() WHERE id = $1`, [conn.id, link.accountId]);
  return { url: link.url };
}

/** GET /api/connect/callback: the provider sends the vendor back here. Readiness comes from the provider, not the redirect. */
export async function onboardingCallback(stateToken: string | null) {
  const s = verifyToken<State>(stateToken);
  if (!s) throw new HttpError(400, 'This onboarding link is invalid or expired. Start again from your shop page.');
  const conn = await one(`SELECT * FROM merchant_connection WHERE id = $1 AND vendor_id = $2 AND status <> 'disconnected'`, [s.c, s.v]);
  if (!conn?.provider_account_id) throw new HttpError(400, 'No onboarding in progress for this shop.');
  const st = await provider(conn.provider).getAccountStatus(conn.provider_account_id);
  await q(`UPDATE merchant_connection SET status = $2, capabilities = $3, updated_at = now() WHERE id = $1`, [conn.id, st.status, JSON.stringify(st.capabilities)]);
  return st.status;
}

/** GET /api/connect/refresh: the provider's link expired; mint a new one. */
export async function refreshOnboarding(stateToken: string | null, origin: string) {
  const s = verifyToken<State>(stateToken);
  if (!s) throw new HttpError(400, 'This onboarding link is invalid or expired. Start again from your shop page.');
  const conn = await one(`SELECT mc.*, v.name FROM merchant_connection mc JOIN vendor v ON v.id = mc.vendor_id WHERE mc.id = $1 AND mc.vendor_id = $2`, [s.c, s.v]);
  assert(conn, 404, 'Onboarding not found.');
  const link = await provider(conn.provider).createOnboardingLink({
    existingAccountId: conn.provider_account_id, businessName: conn.name, vendorId: s.v,
    returnUrl: `${origin}/api/connect/callback?state=${encodeURIComponent(stateToken!)}`,
    refreshUrl: `${origin}/api/connect/refresh?state=${encodeURIComponent(stateToken!)}`,
  });
  return link.url;
}

export async function disconnect(user: User) {
  const conn = await one(`SELECT mc.* FROM merchant_connection mc JOIN vendor v ON v.id = mc.vendor_id WHERE v.owner_id = $1 AND mc.status <> 'disconnected'`, [user.id]);
  assert(conn, 404, 'No merchant account is connected.');
  await disconnectConnection(conn.id, 'vendor_disconnected');
  return { ok: true };
}
export async function disconnectConnection(connectionId: string, reason: string) {
  await q(`UPDATE merchant_connection SET status = 'disconnected', updated_at = now() WHERE id = $1`, [connectionId]);
  const live = await q(`SELECT id FROM group_order WHERE connection_id = $1 AND status IN ('open', 'authorizing')`, [connectionId]);
  for (const g of live) { try { await cancelGroup(g.id, reason); } catch (e) { console.error('cancel on disconnect', g.id, e); } }
}
