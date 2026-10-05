import { one, q, tx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { provider } from '../lib/providers/index.js';
import type { KittyEvent } from '../lib/providers/types.js';
import { disconnectConnection } from './connect.js';
import { notify } from './notifications.js';

/** Webhook ingress: verify the signature, store once per event id, return fast. Processing happens in the background. */
export async function ingest(providerKey: string, headers: Headers, rawBody: string) {
  const p = provider(providerKey);
  let ev;
  try { ev = p.verifyWebhook(headers, rawBody); } catch { throw new HttpError(400, 'Invalid webhook signature.'); }
  const row = await one(`INSERT INTO webhook_event (provider, event_id, account_id, type, payload) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [providerKey, ev.id, ev.accountId, ev.type, JSON.stringify(ev.payload)]);
  return { stored: !!row };
}

/** Claims and applies pending events in order. Returns group ids that became ready to capture. */
export async function processPending(limit = 50) {
  const claimed = await q(`
    UPDATE webhook_event SET claimed_at = now(), attempts = attempts + 1
     WHERE id IN (SELECT id FROM webhook_event WHERE processed_at IS NULL AND attempts < 8
                    AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
                  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [limit]);
  claimed.sort((a, b) => Number(a.id) - Number(b.id));
  const ready = new Set<string>();
  for (const ev of claimed) {
    try {
      const k = await provider(ev.provider).normalizeEvent({ id: ev.event_id, type: ev.type, accountId: ev.account_id, payload: ev.payload });
      const r = await apply(ev.provider, k);
      if (r.capture) ready.add(r.capture);
      await q(`UPDATE webhook_event SET processed_at = now(), result = $2 WHERE id = $1`, [ev.id, `${k.type}: ${r.result}`]);
    } catch (e: any) {
      console.error('webhook processing failed', ev.event_id, e);
      await q(`UPDATE webhook_event SET claimed_at = NULL, result = $2 WHERE id = $1`, [ev.id, 'error: ' + String(e?.message ?? e).slice(0, 300)]);
    }
  }
  return { processed: claimed.length, ready: [...ready] };
}

const findAttempt = `
  SELECT pa.*, c.group_order_id, c.status AS cart_status, c.amount AS cart_amount, g.status AS group_status, g.currency, g.capture_started_at,
         mc.provider_account_id
    FROM payment_attempt pa JOIN cart c ON c.id = pa.cart_id JOIN group_order g ON g.id = c.group_order_id
    JOIN merchant_connection mc ON mc.id = g.connection_id
   WHERE pa.id = $1 OR (pa.provider = $2 AND pa.provider_auth_id = $3)
   ORDER BY (pa.id = $1) DESC LIMIT 1`;
const uuidOrNull = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : '00000000-0000-0000-0000-000000000000');

async function apply(providerKey: string, k: KittyEvent): Promise<{ result: string; capture?: string }> {
  switch (k.type) {
    case 'account.updated': {
      const r = await q(`UPDATE merchant_connection SET status = $1, capabilities = $2, updated_at = now()
        WHERE provider = $3 AND provider_account_id = $4 AND status <> 'disconnected' RETURNING id`,
        [k.account.status, JSON.stringify(k.account.capabilities), providerKey, k.account.accountId]);
      return { result: r.length ? 'applied' : 'no matching connection' };
    }
    case 'account.deauthorized': {
      const conn = await one(`SELECT id FROM merchant_connection WHERE provider = $1 AND provider_account_id = $2 AND status <> 'disconnected'`, [providerKey, k.accountId]);
      if (conn) await disconnectConnection(conn.id, 'vendor_disconnected');
      return { result: conn ? 'disconnected' : 'no matching connection' };
    }
    case 'checkout.authorized': {
      let late: any = null, capture: string | undefined;
      const result = await tx(async c => {
        const a = (await c.query(findAttempt, [uuidOrNull(k.ref.attemptId), providerKey, k.authId])).rows[0];
        if (!a) return 'unknown attempt';
        const g = (await c.query(`SELECT * FROM group_order WHERE id = $1 FOR UPDATE`, [a.group_order_id])).rows[0];
        const cart = (await c.query(`SELECT * FROM cart WHERE id = $1 FOR UPDATE`, [a.cart_id])).rows[0];
        if (['authorized', 'captured', 'voided', 'refunded'].includes(a.status)) return 'already applied';
        await c.query(`UPDATE payment_attempt SET status = 'authorized', provider_auth_id = $2, auth_expires_at = $3, card_brand = $4, card_last4 = $5, updated_at = now() WHERE id = $1`,
          [a.id, k.authId, k.expiresAt, k.brand, k.last4]);
        if (g.status !== 'authorizing' || cart.status !== 'pending') { late = { ...a, provider_auth_id: k.authId }; return 'late authorization, releasing hold'; }
        await c.query(`UPDATE cart SET status = 'authorized', updated_at = now() WHERE id = $1`, [cart.id]);
        await c.query(`INSERT INTO ledger_entry (group_order_id, cart_id, type, amount, currency, provider_ref) VALUES ($1, $2, 'authorized', $3, $4, $5)`,
          [g.id, cart.id, cart.amount, g.currency, k.authId]);
        const { waiting } = (await c.query(`
          SELECT count(*)::int AS waiting FROM cart c
           WHERE c.group_order_id = $1 AND NOT (c.status = 'authorized' AND EXISTS (
             SELECT 1 FROM payment_attempt pa WHERE pa.cart_id = c.id AND pa.status = 'authorized' AND pa.auth_expires_at > now() + interval '15 minutes'))`, [g.id])).rows[0];
        if (waiting === 0) {
          await c.query(`UPDATE group_order SET status = 'capturing', capture_started_at = NULL, updated_at = now() WHERE id = $1`, [g.id]);
          capture = g.id;
        }
        return 'applied';
      });
      if (late) {
        await provider(providerKey).void({ accountId: late.provider_account_id, authId: late.provider_auth_id, idempotencyKey: `late-void-${late.id}` });
        await q(`UPDATE payment_attempt SET status = 'voided', updated_at = now() WHERE id = $1`, [late.id]);
      }
      return { result, capture };
    }
    case 'checkout.declined': {
      const r = await q(`UPDATE payment_attempt SET status = 'declined', decline_reason = $2, updated_at = now()
        WHERE (id = $1 OR (provider = $3 AND provider_auth_id = $4)) AND status = 'created' RETURNING id`,
        [uuidOrNull(k.ref.attemptId), k.reason, providerKey, k.authId]);
      return { result: r.length ? 'applied' : 'no change' };
    }
    case 'checkout.expired': {
      const r = await q(`UPDATE payment_attempt SET status = 'expired', updated_at = now() WHERE provider_session_id = $1 AND status IN ('created', 'declined') RETURNING id`, [k.sessionId]);
      return { result: r.length ? 'applied' : 'no change' };
    }
    case 'authorization.expired': {
      const result = await tx(async c => {
        const a = (await c.query(findAttempt, [uuidOrNull(k.ref.attemptId), providerKey, k.authId])).rows[0];
        if (!a || a.status !== 'authorized') return 'no change';
        await c.query(`SELECT 1 FROM group_order WHERE id = $1 FOR UPDATE`, [a.group_order_id]);
        await c.query(`UPDATE payment_attempt SET status = 'expired', updated_at = now() WHERE id = $1`, [a.id]);
        const moved = (await c.query(`UPDATE cart SET status = 'pending', updated_at = now() WHERE id = $1 AND status = 'authorized' RETURNING amount`, [a.cart_id])).rows[0];
        if (moved) {
          await c.query(`INSERT INTO ledger_entry (group_order_id, cart_id, type, amount, currency, provider_ref) VALUES ($1, $2, 'expired', $3, $4, $5)`,
            [a.group_order_id, a.cart_id, moved.amount, a.currency, k.authId]);
          const who = (await c.query(`SELECT c.shopper_id, g.item_name FROM cart c JOIN group_order g ON g.id = c.group_order_id WHERE c.id = $1`, [a.cart_id])).rows[0];
          await notify([{ userId: who.shopper_id, kind: 'hold_expired', groupId: a.group_order_id, relatedGroupId: null,
            title: `Authorize again: ${who.item_name}`, body: 'The hold on your card expired before the group was complete. Check out again so the group can be charged.' }], c);
        }
        await c.query(`UPDATE group_order SET status = 'authorizing', updated_at = now() WHERE id = $1 AND status = 'capturing' AND capture_started_at IS NULL`, [a.group_order_id]);
        return 'applied: shopper must authorize again';
      });
      return { result };
    }
    case 'authorization.voided':
    case 'capture.succeeded':
    case 'refund.succeeded':
      return { result: 'confirmed' }; // Kitty initiated these; reconciliation checks the amounts against the provider
    default:
      return { result: 'ignored' };
  }
}
