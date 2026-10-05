import { randomUUID } from 'node:crypto';
import type { User } from '../lib/auth.js';
import { nonce, signToken, verifyToken } from '../lib/crypto.js';
import { one, q } from '../lib/db.js';
import { assert, HttpError } from '../lib/http.js';
import { feeFor } from '../lib/money.js';
import { provider } from '../lib/providers/index.js';

const LABEL: Record<string, string> = { doordash: 'DoorDash delivery', uber: 'Uber delivery', pickup: 'in-store pickup' };

/** Checkout Router: creates a hosted checkout on the cart's vendor account and returns where to send the shopper. */
export async function startCheckout(user: User, cartId: string, origin: string) {
  const r = await one(`
    SELECT c.*, g.status AS group_status, g.item_name, g.currency, g.id AS group_id,
           (SELECT count(*)::int FROM cart WHERE group_order_id = g.id) AS n,
           mc.provider, mc.provider_account_id, mc.status AS connection_status, mc.fee_bps
      FROM cart c JOIN group_order g ON g.id = c.group_order_id JOIN merchant_connection mc ON mc.id = g.connection_id
     WHERE c.id = $1`, [cartId]);
  assert(r, 404, 'Cart not found.');
  assert(r.shopper_id === user.id, 403, 'That isn’t your cart.');
  assert(r.group_status === 'authorizing', 409, 'Checkout opens once the group closes.');
  assert(r.status === 'pending', 409, 'This cart already has a live authorization.');
  assert(r.connection_status === 'active', 409, 'This shop’s merchant account isn’t active right now.');

  const attemptId = randomUUID(), returnNonce = nonce(), fee = feeFor(r.amount, r.fee_bps);
  await q(`INSERT INTO payment_attempt (id, cart_id, provider, amount, fee_amount, return_nonce) VALUES ($1, $2, $3, $4, $5, $6)`,
    [attemptId, cartId, r.provider, r.amount, fee, returnNonce]);
  const token = signToken({ a: attemptId, n: returnNonce }, 40 * 60);
  const session = await provider(r.provider).createHostedCheckout({
    accountId: r.provider_account_id, amount: r.amount, currency: r.currency, feeAmount: fee,
    description: `${r.item_name}: 1 of ${r.n} portions, with ${LABEL[r.delivery_method]}`,
    ref: { groupOrderId: r.group_id, cartId, attemptId },
    successUrl: `${origin}/?checkout_return=${encodeURIComponent(token)}`,
    cancelUrl: `${origin}/?checkout_return=${encodeURIComponent(token)}&cancelled=1`,
    idempotencyKey: `session-${attemptId}`,
  });
  await q(`UPDATE payment_attempt SET provider_session_id = $2, updated_at = now() WHERE id = $1`, [attemptId, session.sessionId]);
  return { url: session.url };
}

/** GET /api/checkout/return: verifies the signed, single-use link. The result is provisional; webhooks decide. */
export async function checkoutReturn(user: User, token: string | null) {
  const p = verifyToken<{ a: string; n: string }>(token);
  if (!p) throw new HttpError(400, 'This return link is invalid or has expired.');
  const a = await one(`
    UPDATE payment_attempt pa SET return_used_at = now()
      FROM cart c WHERE pa.id = $1 AND pa.return_nonce = $2 AND pa.return_used_at IS NULL AND c.id = pa.cart_id AND c.shopper_id = $3
    RETURNING pa.id, pa.status, c.group_order_id`, [p.a, p.n, user.id]);
  if (!a) throw new HttpError(409, 'This return link was already used.');
  return { attemptId: a.id, groupOrderId: a.group_order_id, status: a.status };
}

export async function attemptStatus(user: User, attemptId: string) {
  const a = await one(`
    SELECT pa.status, pa.card_brand, pa.card_last4, pa.decline_reason, c.status AS cart_status, g.id AS group_id, g.status AS group_status,
           (SELECT count(*)::int FROM cart WHERE group_order_id = g.id) AS carts,
           (SELECT count(*)::int FROM cart WHERE group_order_id = g.id AND status IN ('authorized', 'captured')) AS authorized
      FROM payment_attempt pa JOIN cart c ON c.id = pa.cart_id JOIN group_order g ON g.id = c.group_order_id
     WHERE pa.id = $1 AND c.shopper_id = $2`, [attemptId, user.id]);
  assert(a, 404, 'Payment attempt not found.');
  return a;
}
