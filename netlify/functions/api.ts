import type { Config, Context } from '@netlify/functions';
import { requireUser, type User } from '../../src/lib/auth.js';
import { q } from '../../src/lib/db.js';
import { body, errorResponse, HttpError, json, redirect } from '../../src/lib/http.js';
import { attemptStatus, checkoutReturn, startCheckout } from '../../src/services/checkout.js';
import { disconnect, onboardingCallback, refreshOnboarding, startOnboarding } from '../../src/services/connect.js';
import { dispatch, markDelivered } from '../../src/services/delivery.js';
import { cancelGroup, closeEarly, createGroup, joinGroup, leaveGroup } from '../../src/services/groups.js';
import { addItem, catalog, me, myVendorId, removeItem, saveVendor, updateItem } from '../../src/services/vendor.js';
import { loadGroups } from '../../src/services/views.js';
import { findSimilar, nearbyGroups, setLocation, viewerPoint, withinArea } from '../../src/services/nearby.js';
import { inbox, markRead } from '../../src/services/notifications.js';
import { health } from '../../src/services/health.js';
import { one } from '../../src/lib/db.js';
import { readRadius } from '../../src/lib/geo.js';

type Handler = (ctx: { req: Request; url: URL; params: Record<string, string>; user: () => Promise<User> }) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
function route(method: string, pattern: string, h: Handler) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push([method, re, h]);
}

// ---- setup check (no sign-in needed, reveals no values) ----
route('GET', '/api/health', async () => json(await health()));

// ---- account and shop ----
route('GET', '/api/me', async ({ user }) => json(await me(await user())));
route('PUT', '/api/me', async ({ req, user }) => {
  const u = await user(), b = await body(req);
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
  if (name) await q(`UPDATE app_user SET name = $2, updated_at = now() WHERE id = $1`, [u.id, name]);
  return json({ ok: true });
});
route('PUT', '/api/me/location', async ({ req, user }) => json(await setLocation(await user(), await body(req))));
route('GET', '/api/notifications', async ({ user }) => json(await inbox(await user())));
route('POST', '/api/notifications/read', async ({ req, user }) => json(await markRead(await user(), (await body(req)).ids)));
route('GET', '/api/catalog', async () => json(await catalog()));
route('PUT', '/api/vendor', async ({ req, user }) => json(await saveVendor(await user(), await body(req))));
route('POST', '/api/vendor/items', async ({ req, user }) => json(await addItem(await user(), await body(req)), 201));
route('PUT', '/api/vendor/items/:id', async ({ req, params, user }) => json(await updateItem(await user(), params.id, await body(req))));
route('DELETE', '/api/vendor/items/:id', async ({ params, user }) => json(await removeItem(await user(), params.id)));
route('GET', '/api/vendor/orders', async ({ user }) => {
  const u = await user(), vid = await myVendorId(u);
  return json({ groups: await loadGroups('g.vendor_id = $1', [vid], u.id, 'vendor', 200) });
});

// ---- Vendor Connect ----
route('POST', '/api/connect/:provider/start', async ({ params, user, url }) => json(await startOnboarding(await user(), params.provider, url.origin)));
route('GET', '/api/connect/callback', async ({ url }) => {
  try { const status = await onboardingCallback(url.searchParams.get('state')); return redirect(`/?connected=${status}#vendor`); }
  catch (e) { return redirect(`/?connect_error=${encodeURIComponent(e instanceof HttpError ? e.message : 'Connection failed.')}#vendor`); }
});
route('GET', '/api/connect/refresh', async ({ url }) => redirect(await refreshOnboarding(url.searchParams.get('state'), url.origin)));
route('POST', '/api/connect/disconnect', async ({ user }) => json(await disconnect(await user())));

// ---- group orders ----
route('GET', '/api/group-orders', async ({ url, user }) => {
  const u = await user();
  if (url.searchParams.get('scope') === 'mine') return json({ groups: await loadGroups('g.id IN (SELECT group_order_id FROM cart WHERE shopper_id = $1)', [u.id], u.id, 'shopper') });
  // Open groups are only listed to people inside their area.
  const point = await viewerPoint(u, url);
  if (!point) throw new HttpError(400, 'Share your location or set your area to see group buys near you.');
  return json({ groups: await nearbyGroups(u, point, readRadius(url.searchParams.get('radius'), 25)) });
});
route('GET', '/api/group-orders/similar', async ({ url, user }) => {
  const u = await user(), point = await viewerPoint(u, url);
  if (!point) throw new HttpError(400, 'Share your location or set your area first.');
  return json({ similar: await findSimilar(u, url.searchParams.get('itemId') ?? '', point, readRadius(url.searchParams.get('radius'))) });
});
route('GET', '/api/group-orders/:id', async ({ params, user, url }) => {
  const u = await user();
  const [g] = await loadGroups('g.id = $1', [params.id], u.id, 'shopper', 1);
  if (!g) throw new HttpError(404, 'Group buy not found.');
  if (!g.carts.some(c => c.isMine) && !g.isVendor) {
    const raw = await one(`SELECT lat, lng, radius_km FROM group_order WHERE id = $1`, [params.id]);
    if (g.status !== 'open' || !withinArea(raw, await viewerPoint(u, url))) throw new HttpError(404, 'Group buy not found.');
  }
  return json(g);
});
route('POST', '/api/group-orders', async ({ req, user }) => json(await createGroup(await user(), await body(req)), 201));
route('POST', '/api/group-orders/:id/carts', async ({ req, params, user }) => { const b = await body(req); return json(await joinGroup(await user(), params.id, b.delivery, b.location), 201); });
route('DELETE', '/api/group-orders/:id/carts/mine', async ({ params, user }) => json(await leaveGroup(await user(), params.id)));
route('POST', '/api/group-orders/:id/close', async ({ params, user }) => json(await closeEarly(await user(), params.id)));
route('POST', '/api/group-orders/:id/cancel', async ({ params, user }) => json(await cancelGroup(params.id, 'initiator_cancelled', await user())));

// ---- Checkout Router ----
route('POST', '/api/carts/:id/checkout', async ({ params, user, url }) => json(await startCheckout(await user(), params.id, url.origin)));
route('GET', '/api/checkout/return', async ({ url, user }) => json(await checkoutReturn(await user(), url.searchParams.get('token'))));
route('GET', '/api/attempts/:id', async ({ params, user }) => json(await attemptStatus(await user(), params.id)));

// ---- delivery ----
route('POST', '/api/carts/:id/dispatch', async ({ params, user }) => json(await dispatch(await user(), params.id)));
route('POST', '/api/carts/:id/delivered', async ({ params, user }) => json(await markDelivered(await user(), params.id)));

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  try {
    for (const [method, re, h] of routes) {
      const m = re.exec(url.pathname);
      if (m && method === req.method) {
        let cached: Promise<User> | null = null;
        return await h({ req, url, params: (m.groups ?? {}) as Record<string, string>, user: () => (cached ??= requireUser(req)) });
      }
    }
    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    return errorResponse(e);
  }
};

export const config: Config = { path: '/api/*' };
