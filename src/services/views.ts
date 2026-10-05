import { unseal } from '../lib/crypto.js';
import { q } from '../lib/db.js';

const DEADLINE_BUFFER_MS = 12 * 3600 * 1000;

/** Loads group orders with carts, latest attempts and deliveries, shaped for the viewer. */
export async function loadGroups(where: string, params: unknown[], viewerId: string, mode: 'shopper' | 'vendor', limit = 100) {
  const groups = await q(`
    SELECT g.*, v.name AS vendor_name, v.owner_id AS vendor_owner, mc.provider
      FROM group_order g JOIN vendor v ON v.id = g.vendor_id JOIN merchant_connection mc ON mc.id = g.connection_id
     WHERE ${where} ORDER BY g.created_at DESC LIMIT ${limit}`, params);
  if (!groups.length) return [];
  const ids = groups.map(g => g.id);
  const carts = await q(`SELECT c.*, u.name AS shopper_name FROM cart c JOIN app_user u ON u.id = c.shopper_id WHERE c.group_order_id = ANY($1) ORDER BY c.joined_at`, [ids]);
  const cartIds = carts.map(c => c.id);
  const attempts = cartIds.length ? await q(`SELECT DISTINCT ON (cart_id) * FROM payment_attempt WHERE cart_id = ANY($1) ORDER BY cart_id, created_at DESC`, [cartIds]) : [];
  const deliveries = cartIds.length ? await q(`SELECT * FROM delivery WHERE cart_id = ANY($1)`, [cartIds]) : [];
  const addresses = mode === 'vendor' && cartIds.length ? await q(`SELECT * FROM shipping_address WHERE cart_id = ANY($1)`, [cartIds]) : [];
  const ledger = mode === 'vendor' ? await q(`SELECT group_order_id, type, sum(amount)::int AS total FROM ledger_entry WHERE group_order_id = ANY($1) GROUP BY 1, 2`, [ids]) : [];
  const byCart = <T extends { cart_id: string }>(rows: T[]) => new Map(rows.map(r => [r.cart_id, r]));
  const att = byCart(attempts), del = byCart(deliveries), addr = byCart(addresses);

  return groups.map(g => {
    const gc = carts.filter(c => c.group_order_id === g.id);
    let deadline = g.authorize_by ? new Date(g.authorize_by).getTime() : null;
    for (const c of gc) {
      const a = att.get(c.id);
      if (c.status === 'authorized' && a?.auth_expires_at && deadline) deadline = Math.min(deadline, new Date(a.auth_expires_at).getTime() - DEADLINE_BUFFER_MS);
    }
    const n = gc.length;
    return {
      id: g.id, itemId: g.item_id, vendor: { id: g.vendor_id, name: g.vendor_name }, provider: g.provider,
      itemName: g.item_name, itemEmoji: g.item_emoji, price: g.price, currency: g.currency, seats: g.seats,
      status: g.status, cancelReason: g.cancel_reason, createdAt: g.created_at, closedAt: g.closed_at,
      areaLabel: g.area_label, radiusKm: g.radius_km, fillBy: g.fill_by, spotsLeft: Math.max(0, g.seats - n),
      deadline: deadline ? new Date(deadline).toISOString() : null,
      isInitiator: g.initiator_id === viewerId, isVendor: g.vendor_owner === viewerId,
      ledger: mode === 'vendor' ? Object.fromEntries(ledger.filter(l => l.group_order_id === g.id).map(l => [l.type, l.total])) : undefined,
      carts: gc.map(c => {
        const mine = c.shopper_id === viewerId, a = att.get(c.id), d = del.get(c.id);
        const base = {
          id: c.id, shopperName: mine ? 'You' : (c.shopper_name || 'Shopper'), isMine: mine, isInitiator: c.shopper_id === g.initiator_id,
          status: c.status, deliveryMethod: c.delivery_method,
          itemShare: c.item_share ?? Math.ceil(g.price / n), amount: c.amount ?? Math.ceil(g.price / n) + c.delivery_fee, deliveryFee: c.delivery_fee,
        };
        if (!mine && mode !== 'vendor') return base;
        let address: unknown = undefined;
        if (mode === 'vendor' && addr.get(c.id)) { try { address = unseal(addr.get(c.id)!.ciphertext); } catch { address = null; } }
        return {
          ...base, address,
          attempt: a ? { id: a.id, status: a.status, brand: a.card_brand, last4: a.card_last4, authExpiresAt: a.auth_expires_at, declineReason: a.decline_reason } : null,
          delivery: d ? { courier: d.courier, status: d.status, trackingUrl: d.tracking_url, externalId: d.external_id } : null,
        };
      }),
    };
  });
}
