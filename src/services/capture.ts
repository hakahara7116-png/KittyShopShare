import { one, q, tx } from '../lib/db.js';
import { provider } from '../lib/providers/index.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Capture orchestrator: all carts or none. Providers capture one authorization at a time,
 * so a failure part-way is compensated: refund what was captured, void the rest.
 * Every provider call carries an idempotency key, so a crashed run can safely be resumed.
 */
export async function runCapture(groupId: string): Promise<string> {
  const g = await one(`UPDATE group_order SET capture_started_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'capturing' AND (capture_started_at IS NULL OR capture_started_at < now() - interval '10 minutes')
     RETURNING *`, [groupId]);
  if (!g) return 'not claimable';
  const conn = await one(`SELECT * FROM merchant_connection WHERE id = $1`, [g.connection_id]);
  const carts = await q(`
    SELECT c.id, c.status, c.amount, pa.id AS attempt_id, pa.status AS attempt_status, pa.provider_auth_id, pa.auth_expires_at, pa.fee_amount
      FROM cart c LEFT JOIN LATERAL (
        SELECT * FROM payment_attempt WHERE cart_id = c.id AND status IN ('authorized', 'captured') ORDER BY created_at DESC LIMIT 1) pa ON true
     WHERE c.group_order_id = $1 ORDER BY c.joined_at, c.id`, [groupId]);

  // Re-check: every cart needs a live hold (or was already captured by an earlier, interrupted run).
  const stale = carts.filter(c => !c.attempt_id || (c.attempt_status === 'authorized' && new Date(c.auth_expires_at).getTime() < Date.now() + 15 * 60_000));
  if (stale.length) {
    await tx(async c => {
      for (const s of stale) {
        if (s.attempt_id) await c.query(`UPDATE payment_attempt SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'authorized'`, [s.attempt_id]);
        await c.query(`UPDATE cart SET status = 'pending', updated_at = now() WHERE id = $1 AND status = 'authorized'`, [s.id]);
      }
      await c.query(`UPDATE group_order SET status = 'authorizing', capture_started_at = NULL, updated_at = now() WHERE id = $1`, [groupId]);
    });
    return `deferred: ${stale.length} hold(s) expired`;
  }

  const p = provider(conn.provider);
  let failed: string | null = null;
  for (const c of carts) {
    if (c.attempt_status === 'captured') continue;
    let r: Awaited<ReturnType<typeof p.capture>> | null = null;
    for (let t = 0; t < 3; t++) {
      r = await p.capture({ accountId: conn.provider_account_id, authId: c.provider_auth_id, idempotencyKey: `capture-${c.attempt_id}` });
      if (r.ok || !r.retryable) break;
      await sleep(500 * (t + 1));
    }
    if (!r!.ok) { failed = `${c.id}: ${(r as any).error}`; break; }
    await tx(async x => {
      await x.query(`UPDATE payment_attempt SET status = 'captured', updated_at = now() WHERE id = $1`, [c.attempt_id]);
      await x.query(`UPDATE cart SET status = 'captured', updated_at = now() WHERE id = $1`, [c.id]);
      await x.query(`INSERT INTO ledger_entry (group_order_id, cart_id, type, amount, currency, provider_ref) VALUES ($1, $2, 'captured', $3, $4, $5), ($1, $2, 'fee', $6, $4, $5)`,
        [groupId, c.id, c.amount, g.currency, (r as any).captureId, c.fee_amount]);
    });
  }
  if (!failed) {
    await q(`UPDATE group_order SET status = 'captured', captured_at = now(), updated_at = now() WHERE id = $1`, [groupId]);
    return 'captured';
  }
  await q(`UPDATE group_order SET status = 'compensating', cancel_reason = 'capture_failed', updated_at = now() WHERE id = $1`, [groupId]);
  await runCompensation(groupId);
  return `compensated after failure: ${failed}`;
}

/** Refunds captured carts and voids remaining holds. Idempotent, so the sweep can resume it. */
export async function runCompensation(groupId: string) {
  const g = await one(`SELECT g.*, mc.provider, mc.provider_account_id FROM group_order g JOIN merchant_connection mc ON mc.id = g.connection_id WHERE g.id = $1 AND g.status = 'compensating'`, [groupId]);
  if (!g) return;
  const p = provider(g.provider);
  const carts = await q(`
    SELECT c.id, c.status, c.amount, pa.id AS attempt_id, pa.provider_auth_id
      FROM cart c JOIN LATERAL (SELECT * FROM payment_attempt WHERE cart_id = c.id AND status IN ('authorized', 'captured') ORDER BY created_at DESC LIMIT 1) pa ON true
     WHERE c.group_order_id = $1`, [groupId]);
  for (const c of carts) {
    if (c.status === 'captured') {
      const r = await p.refund({ accountId: g.provider_account_id, authId: c.provider_auth_id, idempotencyKey: `refund-${c.attempt_id}` });
      await tx(async x => {
        await x.query(`UPDATE payment_attempt SET status = 'refunded', updated_at = now() WHERE id = $1`, [c.attempt_id]);
        await x.query(`UPDATE cart SET status = 'refunded', updated_at = now() WHERE id = $1`, [c.id]);
        await x.query(`INSERT INTO ledger_entry (group_order_id, cart_id, type, amount, currency, provider_ref) VALUES ($1, $2, 'refunded', $3, $4, $5)`, [groupId, c.id, c.amount, g.currency, r.refundId]);
      });
    } else if (c.status === 'authorized') {
      await p.void({ accountId: g.provider_account_id, authId: c.provider_auth_id, idempotencyKey: `void-${c.attempt_id}` });
      await tx(async x => {
        await x.query(`UPDATE payment_attempt SET status = 'voided', updated_at = now() WHERE id = $1`, [c.attempt_id]);
        await x.query(`UPDATE cart SET status = 'voided', updated_at = now() WHERE id = $1`, [c.id]);
        await x.query(`INSERT INTO ledger_entry (group_order_id, cart_id, type, amount, currency, provider_ref) VALUES ($1, $2, 'voided', $3, $4, $5)`, [groupId, c.id, c.amount, g.currency, c.provider_auth_id]);
      });
    }
  }
  await q(`UPDATE cart SET status = 'cancelled', updated_at = now() WHERE group_order_id = $1 AND status = 'pending'`, [groupId]);
  await q(`UPDATE group_order SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1 AND status = 'compensating'`, [groupId]);
}
