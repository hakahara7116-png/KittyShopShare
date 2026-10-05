import type { User } from '../lib/auth.js';
import { seal } from '../lib/crypto.js';
import { tx, type Tx } from '../lib/db.js';
import { readPoint, readRadius, type Point } from '../lib/geo.js';
import { assert, HttpError } from '../lib/http.js';
import { deliveryOption, splitEvenly, type DeliveryMethod } from '../lib/money.js';
import { provider } from '../lib/providers/index.js';
import { announceNewGroup, findSimilar, withinArea } from './nearby.js';
import { notify } from './notifications.js';

const PAY_WINDOW = "interval '5 days'";
export interface DeliveryInput { method: DeliveryMethod; address?: string; phone?: string }

function checkDelivery(vendorDelivery: any, d: DeliveryInput) {
  assert(d && ['doordash', 'uber', 'pickup'].includes(d.method), 400, 'Choose a delivery method.');
  const opt = deliveryOption(vendorDelivery, d.method);
  assert(opt, 400, 'This shop doesn’t offer that delivery method.');
  if (d.method !== 'pickup') {
    assert(typeof d.address === 'string' && d.address.trim().length >= 5 && d.address.length <= 200, 400, 'Add the address your portion should go to.');
    assert(typeof d.phone === 'string' && /^[+0-9 ()-]{7,20}$/.test(d.phone), 400, 'Add a phone number the courier can call.');
  }
  return opt;
}
async function addCart(c: Tx, groupId: string, user: User, d: DeliveryInput, fee: number) {
  const cart = (await c.query(`INSERT INTO cart (group_order_id, shopper_id, delivery_method, delivery_fee) VALUES ($1, $2, $3, $4) RETURNING id`,
    [groupId, user.id, d.method, fee])).rows[0];
  if (d.method !== 'pickup') {
    await c.query(`INSERT INTO shipping_address (cart_id, ciphertext) VALUES ($1, $2)`,
      [cart.id, seal({ address: d.address!.trim(), phone: d.phone!.trim(), name: user.name ?? 'Kitty shopper' })]);
  }
  return cart.id as string;
}
/** Fixes each cart's share: even split of the item price, leftover cents to the earliest carts. */
export async function closeGroup(c: Tx, groupId: string) {
  const g = (await c.query(`SELECT price FROM group_order WHERE id = $1`, [groupId])).rows[0];
  const carts = (await c.query(`SELECT id, delivery_fee FROM cart WHERE group_order_id = $1 ORDER BY joined_at, id`, [groupId])).rows;
  const shares = splitEvenly(g.price, carts.length);
  for (let i = 0; i < carts.length; i++) {
    await c.query(`UPDATE cart SET item_share = $2, amount = $3, updated_at = now() WHERE id = $1`, [carts[i].id, shares[i], shares[i] + carts[i].delivery_fee]);
  }
  const g2 = (await c.query(`UPDATE group_order SET status = 'authorizing', closed_at = now(), authorize_by = now() + ${PAY_WINDOW}, updated_at = now() WHERE id = $1 RETURNING item_name, authorize_by`, [groupId])).rows[0];
  const shoppers = (await c.query(`SELECT shopper_id FROM cart WHERE group_order_id = $1`, [groupId])).rows;
  await notify(shoppers.map((r: any) => ({
    userId: r.shopper_id, kind: 'checkout_needed' as const, groupId,
    title: `Check out now: ${g2.item_name}`,
    body: `Your group closed with ${carts.length} shoppers. Authorize your cart by ${new Date(g2.authorize_by).toUTCString().slice(0, 16)} so everyone gets their portion.`,
  })), c);
}
const lockGroup = async (c: Tx, id: string) => {
  const g = (await c.query(`SELECT * FROM group_order WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  assert(g, 404, 'This group buy no longer exists.');
  return g;
};

const FILL_BY_HOURS = [24, 72, 168];
export interface CreateInput { itemId: string; seats: number; delivery: DeliveryInput; location: Point; areaLabel?: string; radiusKm?: number; fillByHours?: number; confirmNew?: boolean }

export async function createGroup(user: User, input: CreateInput) {
  const seats = Number(input.seats);
  assert(Number.isInteger(seats) && seats >= 2 && seats <= 10, 400, 'Choose 2 to 10 shoppers.');
  const point = readPoint(input.location)!;
  const radiusKm = readRadius(input.radiusKm);
  const fillByHours = FILL_BY_HOURS.includes(Number(input.fillByHours)) ? Number(input.fillByHours) : 72;
  const areaLabel = typeof input.areaLabel === 'string' ? input.areaLabel.trim().slice(0, 60) : null;
  // Tell the would-be initiator about groups already forming nearby for this item before creating another one.
  const similar = await findSimilar(user, input.itemId, point, radiusKm);
  if (similar.length && !input.confirmNew) {
    throw new HttpError(409, 'Similar group buys are already forming near you.', { similar });
  }
  const created = await tx(async c => {
    const it = (await c.query(`
      SELECT i.*, v.delivery, mc.id AS connection_id, mc.status AS connection_status
        FROM item i JOIN vendor v ON v.id = i.vendor_id
        LEFT JOIN merchant_connection mc ON mc.vendor_id = v.id AND mc.status <> 'disconnected'
       WHERE i.id = $1 AND i.active`, [input.itemId])).rows[0];
    assert(it, 404, 'That item isn’t available.');
    assert(it.connection_status === 'active', 409, 'This shop isn’t taking payments right now.');
    assert(it.stock > 0, 409, 'That item is out of stock.');
    const opt = checkDelivery(it.delivery, input.delivery);
    const g = (await c.query(`
      INSERT INTO group_order (vendor_id, item_id, connection_id, item_name, item_emoji, price, currency, seats, initiator_id, lat, lng, area_label, radius_km, fill_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(hours => $14)) RETURNING id`,
      [it.vendor_id, it.id, it.connection_id, it.name, it.emoji, it.price, it.currency, seats, user.id, point.lat, point.lng, areaLabel, radiusKm, fillByHours])).rows[0];
    await addCart(c, g.id, user, input.delivery, opt!.fee);
    return { id: g.id as string };
  });
  try { await announceNewGroup(created.id, similar.map(s => ({ id: s.id, distanceKm: s.distanceKm }))); } catch (e) { console.error('announce failed', e); }
  return created;
}

export async function joinGroup(user: User, groupId: string, delivery: DeliveryInput, location: unknown) {
  const point = readPoint(location, false);
  return tx(async c => {
    const g = await lockGroup(c, groupId);
    assert(g.status === 'open', 409, 'This group is no longer taking shoppers.');
    assert(withinArea(g, point), 403, `This group is open to shoppers within ${g.radius_km} km of where it started.`);
    const { n, mine } = (await c.query(`SELECT count(*)::int AS n, bool_or(shopper_id = $2) AS mine FROM cart WHERE group_order_id = $1`, [groupId, user.id])).rows[0];
    assert(!mine, 409, 'You’re already in this group.');
    assert(n < g.seats, 409, 'That group just filled up.');
    const v = (await c.query(`SELECT delivery FROM vendor WHERE id = $1`, [g.vendor_id])).rows[0];
    const opt = checkDelivery(v.delivery, delivery);
    const cartId = await addCart(c, groupId, user, delivery, opt!.fee);
    if (n + 1 >= g.seats) await closeGroup(c, groupId);
    return { cartId };
  });
}

export async function leaveGroup(user: User, groupId: string) {
  return tx(async c => {
    const g = await lockGroup(c, groupId);
    assert(g.status === 'open', 409, 'The group has closed, so you can’t leave now.');
    assert(g.initiator_id !== user.id, 409, 'You started this group. Cancel it instead.');
    await c.query(`DELETE FROM cart WHERE group_order_id = $1 AND shopper_id = $2`, [groupId, user.id]);
    return { ok: true };
  });
}

export async function closeEarly(user: User, groupId: string) {
  return tx(async c => {
    const g = await lockGroup(c, groupId);
    assert(g.initiator_id === user.id, 403, 'Only the shopper who started the group can close it.');
    assert(g.status === 'open', 409, 'This group is already closed.');
    const { n } = (await c.query(`SELECT count(*)::int AS n FROM cart WHERE group_order_id = $1`, [groupId])).rows[0];
    assert(n >= 2, 409, 'A group needs at least 2 shoppers.');
    await closeGroup(c, groupId);
    return { ok: true };
  });
}

/** Cancels a group and voids every live authorization. Safe to call from the API, webhooks or the sweep. */
export async function cancelGroup(groupId: string, reason: string, byUser?: User) {
  const voids = await tx(async c => {
    const g = await lockGroup(c, groupId);
    if (byUser) assert(g.initiator_id === byUser.id, 403, 'Only the shopper who started the group can cancel it.');
    assert(['open', 'authorizing'].includes(g.status), 409, 'This group can’t be cancelled in its current state.');
    const held = (await c.query(`
      SELECT c.id AS cart_id, c.amount, pa.id AS attempt_id, pa.provider_auth_id, mc.provider, mc.provider_account_id
        FROM cart c JOIN group_order g ON g.id = c.group_order_id JOIN merchant_connection mc ON mc.id = g.connection_id
        JOIN payment_attempt pa ON pa.cart_id = c.id AND pa.status = 'authorized'
       WHERE c.group_order_id = $1`, [groupId])).rows;
    for (const h of held) {
      await c.query(`UPDATE payment_attempt SET status = 'voided', updated_at = now() WHERE id = $1`, [h.attempt_id]);
      await c.query(`INSERT INTO ledger_entry (group_order_id, cart_id, type, amount, currency, provider_ref) VALUES ($1, $2, 'voided', $3, $4, $5)`,
        [groupId, h.cart_id, h.amount, g.currency, h.provider_auth_id]);
    }
    await c.query(`UPDATE cart SET status = CASE WHEN status = 'authorized' THEN 'voided' ELSE 'cancelled' END, updated_at = now() WHERE group_order_id = $1 AND status IN ('pending', 'authorized')`, [groupId]);
    await c.query(`UPDATE group_order SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_at = now() WHERE id = $1`, [groupId, reason]);
    const members = (await c.query(`SELECT shopper_id FROM cart WHERE group_order_id = $1 AND shopper_id <> $2`, [groupId, byUser?.id ?? ''])).rows;
    const why: Record<string, string> = { not_filled: 'it didn’t get enough shoppers before its deadline', deadline_passed: 'not every cart was authorized in time',
      vendor_disconnected: 'the shop disconnected its payment account', initiator_cancelled: 'the shopper who started it cancelled' };
    await notify(members.map((m: any) => ({ userId: m.shopper_id, kind: 'group_cancelled' as const, groupId,
      title: `Group buy cancelled: ${g.item_name}`, body: `It was cancelled because ${why[reason] ?? 'it couldn’t complete'}. Any hold on your card was released.` })), c);
    return held;
  });
  for (const h of voids) {
    try { await provider(h.provider).void({ accountId: h.provider_account_id, authId: h.provider_auth_id, idempotencyKey: `void-${h.attempt_id}` }); }
    catch (e) { console.error('void failed; the provider will release the hold when it expires', h.attempt_id, e); }
  }
  return { ok: true, voided: voids.length };
}
