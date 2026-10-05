import type { User } from '../lib/auth.js';
import { one, q } from '../lib/db.js';
import { assert } from '../lib/http.js';
import { geocoderAvailable } from '../lib/geo.js';
import { availableProviders } from '../lib/providers/index.js';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cents = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
const CATEGORIES = ['Groceries', 'Bulk & household', 'Meat & seafood', 'Electronics', 'Home & garden', 'Other'];

export async function me(user: User) {
  const vendor = await one(`SELECT * FROM vendor WHERE owner_id = $1`, [user.id]);
  const connection = vendor ? await one(`SELECT provider, provider_account_id, status, capabilities, fee_bps FROM merchant_connection WHERE vendor_id = $1 AND status <> 'disconnected'`, [vendor.id]) : null;
  const items = vendor ? await q(`SELECT * FROM item WHERE vendor_id = $1 AND active ORDER BY created_at`, [vendor.id]) : [];
  const location = await one(`SELECT home_lat AS lat, home_lng AS lng, home_label AS label, alerts_enabled AS "alertsEnabled", alert_radius_km AS "alertRadiusKm" FROM app_user WHERE id = $1`, [user.id]);
  return { user, vendor, connection, items, providers: availableProviders(), location, geocoder: geocoderAvailable() };
}

export async function catalog() {
  const rows = await q(`
    SELECT v.id, v.name, v.area, v.about, v.delivery, mc.provider,
           coalesce(json_agg(json_build_object('id', i.id, 'name', i.name, 'emoji', i.emoji, 'category', i.category,
             'description', i.description, 'price', i.price, 'currency', i.currency, 'stock', i.stock) ORDER BY i.created_at)
             FILTER (WHERE i.id IS NOT NULL), '[]') AS items
      FROM vendor v JOIN merchant_connection mc ON mc.vendor_id = v.id AND mc.status = 'active'
      LEFT JOIN item i ON i.vendor_id = v.id AND i.active
     GROUP BY v.id, mc.provider ORDER BY v.name`);
  return { vendors: rows };
}

export async function saveVendor(user: User, b: any) {
  const name = str(b.name, 80);
  assert(name, 400, 'Add a shop name.');
  const d = b.delivery ?? {};
  const delivery = {
    doordash: { on: !!d.doordash?.on, fee: cents(d.doordash?.fee), eta: str(d.doordash?.eta, 40) },
    uber: { on: !!d.uber?.on, fee: cents(d.uber?.fee), eta: str(d.uber?.eta, 40) },
    pickup: { on: !!d.pickup?.on, eta: str(d.pickup?.eta, 40) },
  };
  assert(delivery.doordash.on || delivery.uber.on || delivery.pickup.on, 400, 'Turn on at least one way to get orders to shoppers.');
  const pickupAddress = str(b.pickupAddress, 200), pickupPhone = str(b.pickupPhone, 20);
  if (delivery.doordash.on || delivery.uber.on) assert(pickupAddress && pickupPhone, 400, 'Couriers need your pickup address and phone.');
  return one(`
    INSERT INTO vendor (owner_id, name, area, about, pickup_address, pickup_phone, delivery) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (owner_id) DO UPDATE SET name = EXCLUDED.name, area = EXCLUDED.area, about = EXCLUDED.about,
      pickup_address = EXCLUDED.pickup_address, pickup_phone = EXCLUDED.pickup_phone, delivery = EXCLUDED.delivery, updated_at = now()
    RETURNING *`, [user.id, name, str(b.area, 80), str(b.about, 300), pickupAddress, pickupPhone, JSON.stringify(delivery)]);
}

async function myVendorId(user: User) {
  const v = await one(`SELECT id FROM vendor WHERE owner_id = $1`, [user.id]);
  assert(v, 409, 'Open your shop first.');
  return v.id as string;
}
function itemFields(b: any) {
  const name = str(b.name, 100), price = cents(b.price), stock = Math.max(0, Math.floor(Number(b.stock) || 0));
  assert(name, 400, 'Add an item name.');
  assert(price > 0, 400, 'Enter a price above $0.');
  return [name, str(b.emoji, 8) || '📦', CATEGORIES.includes(b.category) ? b.category : 'Other', str(b.description, 400), price, stock];
}
export async function addItem(user: User, b: any) {
  const vid = await myVendorId(user);
  return one(`INSERT INTO item (vendor_id, name, emoji, category, description, price, stock) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [vid, ...itemFields(b)]);
}
export async function updateItem(user: User, id: string, b: any) {
  const vid = await myVendorId(user);
  const row = await one(`UPDATE item SET name = $3, emoji = $4, category = $5, description = $6, price = $7, stock = $8, updated_at = now()
    WHERE id = $1 AND vendor_id = $2 AND active RETURNING *`, [id, vid, ...itemFields(b)]);
  assert(row, 404, 'Item not found.');
  return row;
}
export async function removeItem(user: User, id: string) {
  const vid = await myVendorId(user);
  const busy = await one(`SELECT 1 FROM group_order WHERE item_id = $1 AND status IN ('open', 'authorizing', 'capturing', 'captured', 'compensating') LIMIT 1`, [id]);
  assert(!busy, 409, 'Shoppers have an active group buy on this item. Remove it after that order is finished.');
  await q(`UPDATE item SET active = false, updated_at = now() WHERE id = $1 AND vendor_id = $2`, [id, vid]);
  return { ok: true };
}
export { myVendorId };
