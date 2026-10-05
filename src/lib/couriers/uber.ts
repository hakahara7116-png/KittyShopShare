import type { Courier, CourierStatus } from './types.js';

// Uber Direct. Written against Uber's public Direct API docs; confirm the address format in their sandbox.
let cached: { token: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const r = await fetch('https://auth.uber.com/oauth/v2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.UBER_DIRECT_CLIENT_ID!, client_secret: process.env.UBER_DIRECT_CLIENT_SECRET!, grant_type: 'client_credentials', scope: 'eats.deliveries' }) });
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Uber auth ${r.status}`);
  cached = { token: d.access_token, until: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return cached.token;
}
const base = () => `https://api.uber.com/v1/customers/${process.env.UBER_DIRECT_CUSTOMER_ID}/deliveries`;
function map(s: string): CourierStatus {
  if (s === 'delivered') return 'delivered';
  if (['pickup_complete', 'dropoff'].includes(s)) return 'picked_up';
  if (['canceled', 'returned'].includes(s)) return 'cancelled';
  return 'requested';
}
async function call(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' } });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Uber Direct ${r.status}: ${d?.message ?? 'request failed'}`);
  return d;
}
export const uber: Courier = {
  key: 'uber',
  configured: () => !!(process.env.UBER_DIRECT_CUSTOMER_ID && process.env.UBER_DIRECT_CLIENT_ID && process.env.UBER_DIRECT_CLIENT_SECRET),
  async create(r) {
    const d = await call(base(), { method: 'POST', body: JSON.stringify({
      external_id: r.externalId,
      pickup_name: r.pickup.name, pickup_address: r.pickup.address, pickup_phone_number: r.pickup.phone,
      dropoff_name: r.dropoff.name, dropoff_address: r.dropoff.address, dropoff_phone_number: r.dropoff.phone,
      manifest_items: [{ name: r.description, quantity: 1 }], manifest_total_value: r.valueCents,
    }) });
    return { externalId: d.id, trackingUrl: d.tracking_url ?? null, status: map(d.status ?? 'pending') };
  },
  async status(externalId) { return map((await call(`${base()}/${encodeURIComponent(externalId)}`)).status); },
};
