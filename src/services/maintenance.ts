import { q } from '../lib/db.js';
import { provider } from '../lib/providers/index.js';
import { tx } from '../lib/db.js';
import { cancelGroup, closeGroup } from './groups.js';

/** Hard deadline: authorizing groups past authorize_by are cancelled and their holds voided. */
export async function cancelOverdueGroups() {
  const overdue = await q(`SELECT id FROM group_order WHERE status = 'authorizing' AND authorize_by < now() LIMIT 20`);
  for (const g of overdue) { try { await cancelGroup(g.id, 'deadline_passed'); } catch (e) { console.error('overdue cancel', g.id, e); } }
  return overdue.length;
}

/** Safety net if an expiry webhook was missed: holds past their expiry go back to pending. */
export async function expireLapsedHolds() {
  const lapsed = await q(`
    WITH a AS (UPDATE payment_attempt SET status = 'expired', updated_at = now()
                WHERE status = 'authorized' AND auth_expires_at < now() RETURNING cart_id)
    UPDATE cart SET status = 'pending', updated_at = now() WHERE id IN (SELECT cart_id FROM a) AND status = 'authorized' RETURNING group_order_id`);
  return lapsed.length;
}

export async function needsProcessor() {
  const r = await q(`
    SELECT (SELECT count(*) FROM webhook_event WHERE processed_at IS NULL AND attempts < 8)::int AS events,
           (SELECT count(*) FROM group_order WHERE (status = 'capturing' AND (capture_started_at IS NULL OR capture_started_at < now() - interval '10 minutes'))
                                               OR (status = 'compensating' AND updated_at < now() - interval '10 minutes'))::int AS groups`);
  return r[0].events > 0 || r[0].groups > 0;
}

/** Compares Kitty's ledger with what the provider reports for recently settled groups. */
export async function reconcile(maxCalls = 40) {
  const groups = await q(`
    SELECT g.id, mc.provider, mc.provider_account_id FROM group_order g JOIN merchant_connection mc ON mc.id = g.connection_id
     WHERE g.updated_at > now() - interval '3 days' AND (g.status IN ('captured', 'complete') OR g.cancel_reason = 'capture_failed')
       AND NOT EXISTS (SELECT 1 FROM reconciliation_result r WHERE r.group_order_id = g.id AND r.matched AND r.run_at > g.updated_at)
     LIMIT 20`);
  let calls = 0, mismatches = 0;
  for (const g of groups) {
    const attempts = await q(`SELECT pa.provider_auth_id FROM payment_attempt pa JOIN cart c ON c.id = pa.cart_id WHERE c.group_order_id = $1 AND pa.status IN ('captured', 'refunded')`, [g.id]);
    if (calls + attempts.length > maxCalls) break;
    let providerNet = 0;
    for (const a of attempts) { providerNet += await provider(g.provider).netCollected({ accountId: g.provider_account_id, authId: a.provider_auth_id }); calls++; }
    const [{ net }] = await q(`SELECT coalesce(sum(CASE type WHEN 'captured' THEN amount WHEN 'refunded' THEN -amount ELSE 0 END), 0)::int AS net FROM ledger_entry WHERE group_order_id = $1`, [g.id]);
    const matched = net === providerNet;
    if (!matched) mismatches++;
    await q(`INSERT INTO reconciliation_result (group_order_id, ledger_net, provider_net, matched, detail) VALUES ($1, $2, $3, $4, $5)`,
      [g.id, net, providerNet, matched, matched ? null : 'ledger and provider disagree; review before payout questions arise']);
  }
  return { checked: groups.length, mismatches };
}

/** Fill-by deadline: a group with 2+ shoppers closes with whoever joined; otherwise it's cancelled. */
export async function settleUnfilledGroups() {
  const due = await q(`SELECT id FROM group_order WHERE status = 'open' AND fill_by < now() ORDER BY fill_by LIMIT 20`);
  let closed = 0, cancelled = 0;
  for (const g of due) {
    try {
      const outcome = await tx(async c => {
        const row = (await c.query(`SELECT status FROM group_order WHERE id = $1 FOR UPDATE`, [g.id])).rows[0];
        if (row.status !== 'open') return 'skip';
        const { n } = (await c.query(`SELECT count(*)::int AS n FROM cart WHERE group_order_id = $1`, [g.id])).rows[0];
        if (n < 2) return 'cancel';
        await closeGroup(c, g.id);
        return 'closed';
      });
      if (outcome === 'cancel') { await cancelGroup(g.id, 'not_filled'); cancelled++; }
      if (outcome === 'closed') closed++;
    } catch (e) { console.error('fill-by', g.id, e); }
  }
  return { closed, cancelled };
}
