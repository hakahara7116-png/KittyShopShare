// Integration test: real SQL (PGlite, an embedded Postgres) + the real services, with a fake Stripe client.
// Run: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build(ROOT);
import crypto from 'node:crypto';
Object.assign(process.env, { TOKEN_SIGNING_SECRET: 'test-secret', ADDRESS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), INTERNAL_TASK_SECRET: 'internal',
  STRIPE_SECRET_KEY: 'sk_test', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec', NETLIFY_DEV: 'true', DEV_AUTH: 'true', PLATFORM_FEE_BPS: '300' });
const { pg } = await import('./db-shim.mjs');
const S = await import('./stripe-fake.mjs');
const api = (await import('./.out/api.js')).default, hook = (await import('./.out/hook.js')).default, bg = (await import('./.out/bg.js')).default;
const maint = await import('./.out/maint.js');
const bgRuns = [];
globalThis.fetch = async (url, init) => { if (String(url).includes('process-background')) { bgRuns.push(bg(new Request(url, init), {})); return new Response(null, { status: 202 }); } throw new Error('unexpected fetch ' + url); };
const settle = async () => { while (bgRuns.length) await bgRuns.shift(); };
for (const f of fs.readdirSync(path.join(ROOT, 'netlify/database/migrations')).sort()) await pg.exec(fs.readFileSync(path.join(ROOT, 'netlify/database/migrations', f), 'utf8'));
console.log('migration applied');

async function call(method, path, user, body) {
  const r = await api(new Request('http://localhost:8888' + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-dev-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), {});
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, location: r.headers.get('location') };
}
async function webhook(ev) {
  const r = await hook(new Request('http://localhost:8888/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'valid' }, body: JSON.stringify(ev) }), {});
  return r.status;
}
const HERE = { lat: 32.7767, lng: -96.7970 }; // all earlier shoppers share one area
const ok = (cond, msg) => { if (!cond) { console.log('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };
const piOf = url => url.split('/').pop();
const authorizeVia = async (url, acct) => { const pi = S.authorize(piOf(url)); return webhook(S.event('payment_intent.amount_capturable_updated', { id: pi.id, metadata: pi.metadata }, acct)); };

// 1. vendor onboarding
let r = await call('PUT', '/api/vendor', 'Vera', { name: 'Vera Farm', area: 'Downtown', pickupAddress: '1 Market St', pickupPhone: '+1 555 0100',
  delivery: { doordash: { on: true, fee: 699, eta: '40 min' }, uber: { on: false }, pickup: { on: true, eta: 'today' } } });
ok(r.status === 200 && r.data.name === 'Vera Farm', 'vendor saved');
r = await call('POST', '/api/vendor/items', 'Vera', { name: 'Quarter beef', emoji: '🥩', category: 'Meat & seafood', price: 48000, stock: 4 });
const itemId = r.data.id; ok(r.status === 201, 'item added');
r = await call('POST', '/api/connect/stripe/start', 'Vera');
ok(r.status === 200 && r.data.url.includes('connect.stripe.test'), 'onboarding link created');
const acct = Object.keys(S.state.accounts)[0];
const state = new URL(decodeURIComponent(r.data.url.split('return=')[1])).searchParams.get('state');
r = await call('GET', '/api/connect/callback?state=' + encodeURIComponent(state));
ok(r.status === 302 && r.location.includes('connected=pending'), 'callback before verification -> pending: ' + r.location);
r = await call('POST', '/api/group-orders', 'Ann', { itemId, seats: 3, delivery: { method: 'pickup' } , location: HERE, confirmNew: true });
ok(r.status === 409, 'cannot start group while account pending');
S.state.accounts[acct].charges_enabled = true; S.state.accounts[acct].payouts_enabled = true;
ok(await webhook(S.event('account.updated', S.state.accounts[acct], acct)) === 200, 'account.updated webhook accepted'); await settle();
r = await call('GET', '/api/catalog');
ok(r.data.vendors.length === 1 && r.data.vendors[0].provider === 'stripe', 'shop appears in catalog once active');

// 2. group forms and closes
r = await call('POST', '/api/group-orders', 'Ann', { itemId, seats: 3, delivery: { method: 'doordash', address: '10 Elm St', phone: '+1 555 0111' } , location: HERE, confirmNew: true });
const gid = r.data.id; ok(r.status === 201, 'Ann starts group');
ok((await call('POST', `/api/group-orders/${gid}/carts`, 'Bob', { delivery: { method: 'uber', address: 'x', phone: '1' } , location: HERE })).status === 400, 'disabled delivery method rejected');
ok((await call('POST', `/api/group-orders/${gid}/carts`, 'Bob', { delivery: { method: 'pickup' } , location: HERE })).status === 201, 'Bob joins (pickup)');
ok((await call('POST', `/api/group-orders/${gid}/carts`, 'Bob', { delivery: { method: 'pickup' } , location: HERE })).status === 409, 'Bob cannot join twice');
ok((await call('POST', `/api/group-orders/${gid}/carts`, 'Cara', { delivery: { method: 'doordash', address: '22 Oak Ave', phone: '+1 555 0122' } , location: HERE })).status === 201, 'Cara joins, group full');
r = await call('GET', '/api/group-orders?scope=mine', 'Ann');
const g = r.data.groups[0];
ok(g.status === 'authorizing' && g.carts.map(c => c.amount).join() === '16699,16000,16699', 'group closed, shares fixed: ' + g.carts.map(c => c.amount));
ok(g.carts[1].attempt === undefined && g.carts[1].address === undefined, 'other shoppers see no payment or address details');
const cartOf = (gr, name) => gr.carts.find(c => c.isMine) ?? null;

// 3. checkout redirection
const annCart = g.carts[0].id;
ok((await call('POST', `/api/carts/${annCart}/checkout`, 'Bob')).status === 403, 'Bob cannot check out Ann\'s cart');
r = await call('POST', `/api/carts/${annCart}/checkout`, 'Ann');
const annUrl = r.data.url; ok(annUrl?.startsWith('https://checkout.stripe.test/'), 'Ann redirected to hosted checkout');
const sess = Object.values(S.state.sessions).at(-1);
ok(S.state.calls.at(-1)[1] === acct && S.state.calls.at(-1)[2] === 'manual' && S.state.calls.at(-1)[3] === 501, 'session on vendor account, manual capture, 3% fee: ' + S.state.calls.at(-1));
const token = new URL(sess.success_url).searchParams.get('checkout_return');
ok(await authorizeVia(annUrl, acct) === 200, 'Ann authorization webhook'); 
const dupEv = S.event('payment_intent.amount_capturable_updated', { id: piOf(annUrl), metadata: S.state.pis[piOf(annUrl)].metadata }, acct);
await webhook(dupEv); await webhook(dupEv); await settle();
const [{ n: stored }] = (await pg.query(`SELECT count(*)::int AS n FROM webhook_event WHERE event_id = $1`, [dupEv.id])).rows;
ok(stored === 1, 'duplicate webhook stored once');
r = await call('GET', '/api/checkout/return?token=' + encodeURIComponent(token), 'Bob');
ok(r.status === 409, 'return link rejected for another user');
r = await call('GET', '/api/checkout/return?token=' + encodeURIComponent(token), 'Ann');
ok(r.status === 200 && r.data.status === 'authorized', 'return link verified: ' + JSON.stringify(r.data));
ok((await call('GET', '/api/checkout/return?token=' + encodeURIComponent(token), 'Ann')).status === 409, 'return link is single-use');
ok((await call('GET', '/api/checkout/return?token=' + encodeURIComponent(token.slice(0, -2) + 'xx'), 'Ann')).status === 400, 'tampered link rejected');

// Bob declines, retries
r = await call('GET', '/api/group-orders?scope=mine', 'Bob'); const bobCart = r.data.groups[0].carts.find(c => c.isMine).id;
r = await call('POST', `/api/carts/${bobCart}/checkout`, 'Bob'); let pi = S.state.pis[piOf(r.data.url)];
await webhook(S.event('payment_intent.payment_failed', { id: pi.id, metadata: pi.metadata, last_payment_error: { message: 'Your card was declined.' } }, acct)); await settle();
r = await call('GET', '/api/group-orders?scope=mine', 'Bob');
ok(r.data.groups[0].carts.find(c => c.isMine).attempt.status === 'declined', 'Bob declined, cart still pending');
r = await call('POST', `/api/carts/${bobCart}/checkout`, 'Bob'); await authorizeVia(r.data.url, acct); await settle();

// hold expiry for Bob, then re-authorize
const bobPi = piOf(r.data.url);
await webhook(S.event('payment_intent.canceled', { id: bobPi, metadata: S.state.pis[bobPi].metadata, cancellation_reason: 'automatic' }, acct)); await settle();
r = await call('GET', '/api/group-orders?scope=mine', 'Bob');
ok(r.data.groups[0].carts.find(c => c.isMine).status === 'pending', 'expired hold sends Bob back to pending');
r = await call('POST', `/api/carts/${bobCart}/checkout`, 'Bob'); await authorizeVia(r.data.url, acct); await settle();

// Cara completes the group -> capture
r = await call('GET', '/api/group-orders?scope=mine', 'Cara'); const caraCart = r.data.groups[0].carts.find(c => c.isMine).id;
r = await call('POST', `/api/carts/${caraCart}/checkout`, 'Cara'); await authorizeVia(r.data.url, acct); await settle();
r = await call('GET', `/api/group-orders/${gid}`, 'Ann');
ok(r.data.status === 'captured' && r.data.carts.every(c => c.status === 'captured'), 'every cart authorized -> group captured');
ok(S.state.calls.filter(c => c[0] === 'capture').length === 3, 'exactly three captures');

// vendor dispatch
r = await call('GET', '/api/vendor/orders', 'Vera'); const vg = r.data.groups.find(x => x.id === gid);
ok(vg.carts[0].address?.address === '10 Elm St' && vg.carts[1].address === undefined, 'vendor sees decrypted addresses');
ok(vg.ledger.captured === 49398 && vg.ledger.fee === 1482, 'ledger captured and fees: ' + JSON.stringify(vg.ledger));
ok((await call('GET', '/api/vendor/orders', 'Ann')).status === 409, 'non-vendor cannot see orders');
for (const c of vg.carts) ok((await call('POST', `/api/carts/${c.id}/dispatch`, 'Vera')).status === 200, 'dispatched ' + c.deliveryMethod);
ok((await call('POST', `/api/carts/${vg.carts[0].id}/dispatch`, 'Vera')).status === 409, 'no double dispatch');
for (const c of vg.carts) await call('POST', `/api/carts/${c.id}/delivered`, 'Vera');
r = await call('GET', `/api/group-orders/${gid}`, 'Ann');
ok(r.data.status === 'complete', 'all delivered -> complete');
const [{ stock }] = (await pg.query(`SELECT stock FROM item WHERE id = $1`, [itemId])).rows; ok(stock === 3, 'stock decremented once');
const rec = await maint.reconcile(40);
const [{ m }] = (await pg.query(`SELECT bool_and(matched) AS m FROM reconciliation_result`)).rows;
ok(rec.mismatches === 0 && m, 'reconciliation matched: ' + JSON.stringify(rec));

// 4. capture failure -> compensation
r = await call('POST', '/api/group-orders', 'Ann', { itemId, seats: 2, delivery: { method: 'pickup' } , location: HERE, confirmNew: true }); const g2 = r.data.id;
await call('POST', `/api/group-orders/${g2}/carts`, 'Bob', { delivery: { method: 'pickup' } , location: HERE });
r = await call('GET', `/api/group-orders/${g2}`, 'Ann'); const a2 = r.data.carts.find(c => c.isMine).id;
r = await call('GET', `/api/group-orders/${g2}`, 'Bob'); const b2 = r.data.carts.find(c => c.isMine).id;
const u1 = (await call('POST', `/api/carts/${a2}/checkout`, 'Ann')).data.url, u2 = (await call('POST', `/api/carts/${b2}/checkout`, 'Bob')).data.url;
S.state.failCaptureOn = piOf(u2);
await authorizeVia(u1, acct); await authorizeVia(u2, acct); await settle();
r = await call('GET', `/api/group-orders/${g2}`, 'Ann');
ok(r.data.status === 'cancelled' && r.data.cancelReason === 'capture_failed', 'failed capture cancels group');
const g2carts = (await pg.query(`SELECT status FROM cart WHERE group_order_id = $1 ORDER BY joined_at`, [g2])).rows.map(x => x.status).join();
ok(g2carts === 'refunded,voided', 'captured cart refunded, other hold voided: ' + g2carts);
ok(S.state.calls.some(c => c[0] === 'refund' && c[1] === piOf(u1)) && S.state.calls.some(c => c[0] === 'cancel' && c[1] === piOf(u2)), 'provider refund and void issued');
S.state.failCaptureOn = null;

// 5. initiator cancel voids holds; late authorization is released
r = await call('POST', '/api/group-orders', 'Ann', { itemId, seats: 2, delivery: { method: 'pickup' } , location: HERE, confirmNew: true }); const g3 = r.data.id;
await call('POST', `/api/group-orders/${g3}/carts`, 'Cara', { delivery: { method: 'pickup' } , location: HERE });
r = await call('GET', `/api/group-orders/${g3}`, 'Ann'); const a3 = r.data.carts.find(c => c.isMine).id;
r = await call('GET', `/api/group-orders/${g3}`, 'Cara'); const c3 = r.data.carts.find(c => c.isMine).id;
const ua = (await call('POST', `/api/carts/${a3}/checkout`, 'Ann')).data.url, uc = (await call('POST', `/api/carts/${c3}/checkout`, 'Cara')).data.url;
await authorizeVia(ua, acct); await settle();
ok((await call('POST', `/api/group-orders/${g3}/cancel`, 'Cara')).status === 403, 'only initiator can cancel');
ok((await call('POST', `/api/group-orders/${g3}/cancel`, 'Ann')).data.voided === 1, 'cancel voids the one live hold');
await authorizeVia(uc, acct); await settle();
ok(S.state.calls.some(c => c[0] === 'cancel' && c[1] === piOf(uc)), 'late authorization on cancelled group is released');

// 6. sweep jobs run cleanly
await maint.cancelOverdueGroups(); await maint.expireLapsedHolds(); console.log('needsProcessor:', await maint.needsProcessor());
// 7. nearby discovery, area limits, similar-group alerts, fill-by deadlines
const FAR = { lat: 30.2672, lng: -97.7431 };      // about 300 km away
const NEAR = { lat: 32.79, lng: -96.80 };         // about 1.5 km from HERE
await call('PUT', '/api/me/location', 'Nina', { ...NEAR, label: 'Uptown', alertsEnabled: true, alertRadiusKm: 10 });
await call('PUT', '/api/me/location', 'Faye', { ...FAR, alertsEnabled: true, alertRadiusKm: 50 });
r = await call('POST', '/api/vendor/items', 'Vera', { name: 'Grass-fed beef quarter, 100 lb', price: 52000, stock: 2 }); const beef2 = r.data.id;
r = await call('POST', '/api/group-orders', 'Ann', { itemId, seats: 4, delivery: { method: 'pickup' }, location: HERE, radiusKm: 10, fillByHours: 24 });
const gNear = r.data.id; ok(r.status === 201, 'Ann starts a group with an area and fill-by deadline');
r = await call('GET', `/api/group-orders?scope=nearby&lat=${NEAR.lat}&lng=${NEAR.lng}`, 'Nina');
const seen = r.data.groups?.find(x => x.id === gNear);
ok(seen && seen.distanceKm <= 3 && seen.spotsLeft === 3 && seen.fillBy, 'neighbor sees the group with distance, spots left and deadline: ' + JSON.stringify(seen && { d: seen.distanceKm, s: seen.spotsLeft }));
ok(seen && seen.lat === undefined && seen.lng === undefined, 'exact coordinates are never exposed');
r = await call('GET', `/api/group-orders?lat=${FAR.lat}&lng=${FAR.lng}`, 'Faye');
ok(!r.data.groups.some(x => x.id === gNear), 'shopper in another city does not see it');
ok((await call('GET', `/api/group-orders/${gNear}`, 'Faye')).status === 404, 'far shopper cannot open it directly');
ok((await call('POST', `/api/group-orders/${gNear}/carts`, 'Faye', { delivery: { method: 'pickup' }, location: FAR })).status === 403, 'far shopper cannot join');
ok((await call('GET', '/api/group-orders', 'Zed')).status === 400, 'no location means no nearby list');
r = await call('GET', '/api/notifications', 'Nina');
ok(r.data.items.some(n => n.kind === 'nearby_group' && n.groupId === gNear), 'opted-in neighbor notified of the new group');
ok(!(await call('GET', '/api/notifications', 'Faye')).data.items.some(n => n.groupId === gNear), 'far opted-in shopper not notified');
// similar-group alert for a would-be initiator
r = await call('POST', '/api/group-orders', 'Nina', { itemId, seats: 3, delivery: { method: 'pickup' }, location: NEAR });
ok(r.status === 409 && r.data.similar.some(x => x.id === gNear && x.match === 'same_item'), 'starting the same item nearby returns the existing group instead');
r = await call('GET', `/api/group-orders/similar?itemId=${beef2}&lat=${NEAR.lat}&lng=${NEAR.lng}`, 'Nina');
ok(r.data.similar.some(x => x.id === gNear && x.match === 'similar_item'), 'a similar product from the same shop is flagged too');
r = await call('POST', '/api/group-orders', 'Nina', { itemId: beef2, seats: 3, delivery: { method: 'pickup' }, location: NEAR, confirmNew: true });
const gNina = r.data.id; ok(r.status === 201, 'she can still start her own after seeing it');
r = await call('GET', '/api/notifications', 'Ann');
ok(r.data.items.some(n => n.kind === 'similar_group' && n.groupId === gNear && n.relatedGroupId === gNina), 'existing initiator is told a similar group started nearby');
ok(r.data.unread > 0 && (await call('POST', '/api/notifications/read', 'Ann', {})).status === 200 && (await call('GET', '/api/notifications', 'Ann')).data.unread === 0, 'notifications can be marked read');
// joining from inside the area works
ok((await call('POST', `/api/group-orders/${gNear}/carts`, 'Nina', { delivery: { method: 'pickup' }, location: NEAR })).status === 201, 'neighbor joins');
// fill-by deadline: 2+ shoppers -> closes with them; fewer -> cancelled
await pg.query(`UPDATE group_order SET fill_by = now() - interval '1 minute' WHERE id = ANY($1)`, [[gNear, gNina]]);
const settled = await maint.settleUnfilledGroups();
ok(settled.closed === 1 && settled.cancelled === 1, 'fill-by: one group closed early, one cancelled: ' + JSON.stringify(settled));
r = await call('GET', `/api/group-orders/${gNear}`, 'Ann');
ok(r.data.status === 'authorizing' && r.data.carts.every(c => c.itemShare === 24000), 'closed with 2 shoppers, shares re-split evenly');
r = await call('GET', '/api/notifications', 'Nina');
ok(r.data.items.some(n => n.kind === 'checkout_needed' && n.groupId === gNear), 'shoppers told to check out when it closes');

// 8. setup check and demo sign-in rules
r = await call('GET', '/api/health');
ok(r.status === 200 && r.data.ok && r.data.database.ok && r.data.signIn.demo, 'setup check passes when configured: ' + JSON.stringify(r.data.problems));
const saved = { ...process.env };
delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
r = await call('GET', '/api/health');
ok(!r.data.ok && r.data.problems.some(p => p.includes('STRIPE_CONNECT_WEBHOOK_SECRET')) && !JSON.stringify(r.data).includes('sk_test'), 'setup check names missing settings without revealing values');
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = saved.STRIPE_CONNECT_WEBHOOK_SECRET;
process.env.NETLIFY_DEV = 'false'; process.env.DEV_AUTH = 'false';
ok((await call('GET', '/api/me', 'Mallory')).status === 401, 'deployed site rejects name-only sign-in by default');
process.env.DEMO_AUTH = 'true';
ok((await call('GET', '/api/me', 'Dana')).status === 200, 'DEMO_AUTH=true allows demo sign-in on a deployed test site');
process.env.STRIPE_SECRET_KEY = 'sk_live_x';
ok((await call('GET', '/api/me', 'Dana')).status === 401, 'demo sign-in is refused when a live Stripe key is set');
Object.assign(process.env, saved); delete process.env.DEMO_AUTH;

const errs = (await pg.query(`SELECT result FROM webhook_event WHERE result LIKE 'error%'`)).rows;
ok(errs.length === 0, 'no webhook processing errors ' + JSON.stringify(errs));

console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
process.exit(process.exitCode ?? 0);
