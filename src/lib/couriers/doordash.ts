import { createHmac } from 'node:crypto';
import type { Courier, CourierStatus } from './types.js';

// DoorDash Drive v2. Written against DoorDash's public Drive API docs; confirm fields in their sandbox.
const BASE = 'https://openapi.doordash.com/drive/v2';
const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function token(): string {
  const header = { alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: 'doordash', iss: process.env.DOORDASH_DEVELOPER_ID, kid: process.env.DOORDASH_KEY_ID, iat: now, exp: now + 300 };
  const unsigned = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', Buffer.from(process.env.DOORDASH_SIGNING_SECRET!, 'base64url')).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}
function map(s: string): CourierStatus {
  if (s === 'delivered') return 'delivered';
  if (['picked_up', 'enroute_to_dropoff', 'arrived_at_dropoff'].includes(s)) return 'picked_up';
  if (['cancelled', 'returned'].includes(s)) return 'cancelled';
  return 'requested';
}
async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`DoorDash Drive ${r.status}: ${data?.message ?? 'request failed'}`);
  return data;
}
export const doordash: Courier = {
  key: 'doordash',
  configured: () => !!(process.env.DOORDASH_DEVELOPER_ID && process.env.DOORDASH_KEY_ID && process.env.DOORDASH_SIGNING_SECRET),
  async create(r) {
    const d = await call('/deliveries', { method: 'POST', body: JSON.stringify({
      external_delivery_id: r.externalId,
      pickup_address: r.pickup.address, pickup_business_name: r.pickup.name, pickup_phone_number: r.pickup.phone,
      dropoff_address: r.dropoff.address, dropoff_contact_given_name: r.dropoff.name, dropoff_phone_number: r.dropoff.phone,
      order_value: r.valueCents, items: [{ name: r.description, quantity: 1 }],
    }) });
    return { externalId: d.external_delivery_id ?? r.externalId, trackingUrl: d.tracking_url ?? null, status: map(d.delivery_status ?? 'created') };
  },
  async status(externalId) { return map((await call(`/deliveries/${encodeURIComponent(externalId)}`)).delivery_status); },
};
