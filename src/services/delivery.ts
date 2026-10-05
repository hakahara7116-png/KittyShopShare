import type { User } from '../lib/auth.js';
import { couriers } from '../lib/couriers/index.js';
import type { CourierStatus } from '../lib/couriers/types.js';
import { unseal } from '../lib/crypto.js';
import { one, q, tx } from '../lib/db.js';
import { assert } from '../lib/http.js';

async function vendorCart(user: User, cartId: string) {
  const r = await one(`
    SELECT c.*, g.status AS group_status, g.id AS group_id, g.item_name, g.seats, v.name AS vendor_name, v.pickup_address, v.pickup_phone, v.owner_id
      FROM cart c JOIN group_order g ON g.id = c.group_order_id JOIN vendor v ON v.id = g.vendor_id WHERE c.id = $1`, [cartId]);
  assert(r && r.owner_id === user.id, 404, 'Cart not found.');
  return r;
}

/** One courier job per cart, only after the whole group is captured. */
export async function dispatch(user: User, cartId: string) {
  const c = await vendorCart(user, cartId);
  assert(['captured', 'complete'].includes(c.group_status), 409, 'Dispatch unlocks once the group is captured.');
  assert(c.status === 'captured', 409, 'This cart wasn’t captured.');
  assert(!(await one(`SELECT 1 FROM delivery WHERE cart_id = $1`, [cartId])), 409, 'This cart was already dispatched.');

  let row: { courier: string; external_id: string | null; status: string; tracking_url: string | null };
  if (c.delivery_method === 'pickup') {
    row = { courier: 'pickup', external_id: null, status: 'ready_for_pickup', tracking_url: null };
  } else {
    const courier = couriers[c.delivery_method];
    if (!courier?.configured()) {
      row = { courier: 'manual', external_id: null, status: 'requested', tracking_url: null }; // the shop books the courier itself
    } else {
      const addr = await one(`SELECT ciphertext FROM shipping_address WHERE cart_id = $1`, [cartId]);
      assert(addr, 409, 'This cart has no delivery address.');
      const to = unseal<{ address: string; phone: string; name: string }>(addr.ciphertext);
      const job = await courier.create({
        externalId: cartId, description: `${c.item_name} (1 of ${c.seats} portions)`, valueCents: c.item_share ?? 0,
        pickup: { name: c.vendor_name, address: c.pickup_address, phone: c.pickup_phone },
        dropoff: { name: to.name, address: to.address, phone: to.phone },
      });
      row = { courier: courier.key, external_id: job.externalId, status: job.status, tracking_url: job.trackingUrl };
    }
  }
  await tx(async x => {
    await x.query(`INSERT INTO delivery (cart_id, courier, external_id, status, tracking_url) VALUES ($1, $2, $3, $4, $5)`, [cartId, row.courier, row.external_id, row.status, row.tracking_url]);
    const first = (await x.query(`UPDATE group_order SET stock_taken = true WHERE id = $1 AND NOT stock_taken RETURNING item_id`, [c.group_id])).rows[0];
    if (first) await x.query(`UPDATE item SET stock = GREATEST(stock - 1, 0), updated_at = now() WHERE id = $1`, [first.item_id]);
  });
  return { ok: true, courier: row.courier };
}

export async function markDelivered(user: User, cartId: string) {
  const c = await vendorCart(user, cartId);
  const r = await q(`UPDATE delivery SET status = 'delivered', updated_at = now() WHERE cart_id = $1 AND status <> 'delivered' RETURNING id`, [cartId]);
  assert(r.length, 409, 'Dispatch this cart first.');
  await completeIfDone(c.group_id);
  return { ok: true };
}

export async function completeIfDone(groupId: string) {
  await q(`UPDATE group_order SET status = 'complete', completed_at = now(), updated_at = now()
    WHERE id = $1 AND status = 'captured' AND NOT EXISTS (
      SELECT 1 FROM cart c LEFT JOIN delivery d ON d.cart_id = c.id WHERE c.group_order_id = $1 AND d.status IS DISTINCT FROM 'delivered')`, [groupId]);
}

/** Polls courier APIs for active jobs (scheduled). */
export async function pollDeliveries(limit = 15) {
  const active = await q(`
    SELECT d.*, c.group_order_id FROM delivery d JOIN cart c ON c.id = d.cart_id
     WHERE d.courier IN ('doordash', 'uber') AND d.status IN ('requested', 'picked_up') AND d.updated_at < now() - interval '2 minutes'
     ORDER BY d.updated_at LIMIT $1`, [limit]);
  for (const d of active) {
    try {
      const s: CourierStatus = await couriers[d.courier].status(d.external_id);
      await q(`UPDATE delivery SET status = $2, updated_at = now() WHERE id = $1`, [d.id, s]);
      if (s === 'delivered') await completeIfDone(d.group_order_id);
    } catch (e) { console.error('courier poll', d.id, e); }
  }
}
