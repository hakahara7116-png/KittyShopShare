import type { User } from '../lib/auth.js';
import { one, q } from '../lib/db.js';
import { geocode, haversineKm, readPoint, readRadius, roundDistance, sqlBox, sqlDistance, type Point } from '../lib/geo.js';
import { assert, HttpError } from '../lib/http.js';
import { similarity, SIMILAR_THRESHOLD } from '../lib/similar.js';
import { notify } from './notifications.js';
import { loadGroups } from './views.js';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** PUT /api/me/location: from the browser's location, or a postal code / neighborhood when a geocoder is configured. */
export async function setLocation(user: User, b: any) {
  let point: Point | null = null, label = str(b.label, 60);
  if (typeof b.query === 'string' && b.query.trim()) {
    const g = await geocode(b.query.trim().slice(0, 80));
    if (!g) throw new HttpError(404, 'We couldn’t find that place. Try a postal code.');
    point = g; label ||= g.label;
  } else if (b.lat !== undefined) point = readPoint(b);
  const row = await one(`
    UPDATE app_user SET
      home_lat = COALESCE($2, home_lat), home_lng = COALESCE($3, home_lng), home_label = CASE WHEN $2::float8 IS NULL THEN home_label ELSE NULLIF($4, '') END,
      alerts_enabled = COALESCE($5, alerts_enabled), alert_radius_km = COALESCE($6, alert_radius_km), updated_at = now()
    WHERE id = $1 RETURNING home_lat AS lat, home_lng AS lng, home_label AS label, alerts_enabled AS "alertsEnabled", alert_radius_km AS "alertRadiusKm"`,
    [user.id, point?.lat ?? null, point?.lng ?? null, label, typeof b.alertsEnabled === 'boolean' ? b.alertsEnabled : null, b.alertRadiusKm !== undefined ? readRadius(b.alertRadiusKm) : null]);
  return row;
}
export async function homeOf(userId: string): Promise<Point | null> {
  const r = await one(`SELECT home_lat AS lat, home_lng AS lng FROM app_user WHERE id = $1`, [userId]);
  return r?.lat != null ? { lat: r.lat, lng: r.lng } : null;
}
/** Explicit coordinates from the request win; otherwise the saved area. */
export async function viewerPoint(user: User, url: URL): Promise<Point | null> {
  return readPoint({ lat: url.searchParams.get('lat') ?? undefined, lng: url.searchParams.get('lng') ?? undefined }, false) ?? await homeOf(user.id);
}

/** Open groups whose area covers the viewer, most urgent first. */
export async function nearbyGroups(user: User, point: Point, radiusKm: number) {
  const rows = await q(`
    SELECT id, dist FROM (
      SELECT g.id, g.radius_km, ${sqlDistance(1, 2)} AS dist FROM group_order g
       WHERE g.status = 'open' AND g.lat IS NOT NULL AND ${sqlBox(1, 2, 3)}) x
     WHERE dist <= $3 AND dist <= radius_km LIMIT 150`, [point.lat, point.lng, radiusKm]);
  if (!rows.length) return [];
  const dist = new Map(rows.map(r => [r.id, Number(r.dist)]));
  const groups = await loadGroups('g.id = ANY($1)', [rows.map(r => r.id)], user.id, 'shopper', 150);
  return groups
    .map(g => ({ ...g, distanceKm: roundDistance(dist.get(g.id)!) }))
    .sort((a, b) => (a.spotsLeft - b.spotsLeft) || (Date.parse(a.fillBy ?? '9999') - Date.parse(b.fillBy ?? '9999')) || (a.distanceKm - b.distanceKm));
}

/** Open groups near this point for the same item, or a similar product from any shop. */
export async function findSimilar(user: User, itemId: string, point: Point, radiusKm: number) {
  const item = await one(`SELECT id, name, vendor_id FROM item WHERE id = $1`, [itemId]);
  assert(item, 404, 'That item isn’t available.');
  const rows = await q(`
    SELECT id, item_id, item_name, dist FROM (
      SELECT g.id, g.item_id, g.item_name, g.radius_km, ${sqlDistance(1, 2)} AS dist FROM group_order g
       WHERE g.status = 'open' AND g.lat IS NOT NULL AND ${sqlBox(1, 2, 3)}) x
     WHERE dist <= $3 AND dist <= radius_km LIMIT 200`, [point.lat, point.lng, radiusKm]);
  const matches = rows
    .map(r => ({ id: r.id as string, dist: Number(r.dist), match: r.item_id === itemId ? 'same_item' : similarity(item.name, r.item_name) >= SIMILAR_THRESHOLD ? 'similar_item' : null }))
    .filter(m => m.match);
  if (!matches.length) return [];
  const groups = await loadGroups('g.id = ANY($1)', [matches.map(m => m.id)], user.id, 'shopper', 50);
  const byId = new Map(matches.map(m => [m.id, m]));
  return groups
    .map(g => ({ ...g, match: byId.get(g.id)!.match, distanceKm: roundDistance(byId.get(g.id)!.dist) }))
    .sort((a, b) => (a.match === b.match ? 0 : a.match === 'same_item' ? -1 : 1) || a.distanceKm - b.distanceKm)
    .slice(0, 6);
}

/** After a group starts: tell initiators of similar nearby groups, and opted-in neighbors. Best effort. */
export async function announceNewGroup(groupId: string, similarGroups: { id: string; distanceKm: number }[]) {
  const g = await one(`SELECT g.*, v.name AS vendor_name, u.name AS initiator_name FROM group_order g JOIN vendor v ON v.id = g.vendor_id JOIN app_user u ON u.id = g.initiator_id WHERE g.id = $1`, [groupId]);
  if (!g || g.lat == null) return;
  const fillBy = g.fill_by ? new Date(g.fill_by).toUTCString().slice(0, 16) : 'soon';
  if (similarGroups.length) {
    const owners = await q(`SELECT id, initiator_id FROM group_order WHERE id = ANY($1) AND status = 'open' AND initiator_id <> $2`, [similarGroups.map(s => s.id), g.initiator_id]);
    await notify(owners.map(o => ({
      userId: o.initiator_id, kind: 'similar_group' as const, groupId: o.id, relatedGroupId: groupId,
      title: 'A similar group buy started near yours',
      body: `${g.initiator_name ?? 'A shopper'} started a group for ${g.item_name} about ${similarGroups.find(s => s.id === o.id)?.distanceKm ?? '?'} km away. Shoppers nearby will see both, so share yours to fill it first.`,
    })));
  }
  const neighbors = await q(`
    SELECT id FROM (
      SELECT u.id, u.alert_radius_km, ${sqlDistance(1, 2, 'u.home_lat', 'u.home_lng')} AS dist FROM app_user u
       WHERE u.alerts_enabled AND u.id <> $4 AND u.home_lat IS NOT NULL AND ${sqlBox(1, 2, 3, 'u.home_lat', 'u.home_lng')}) x
     WHERE dist <= alert_radius_km AND dist <= $3 LIMIT 500`, [g.lat, g.lng, g.radius_km, g.initiator_id]);
  await notify(neighbors.map(n => ({
    userId: n.id, kind: 'nearby_group' as const, groupId,
    title: `New group buy near you: ${g.item_name}`,
    body: `${g.vendor_name}. ${g.seats} spots, fills by ${fillBy}. Join before it closes.`,
  })));
}

/** Area check for joining and viewing: you have to be inside the group's radius. */
export function withinArea(group: { lat: number | null; lng: number | null; radius_km: number }, point: Point | null) {
  if (group.lat == null) return true; // groups created before areas existed
  if (!point) return false;
  return haversineKm(point, { lat: group.lat, lng: group.lng! }) <= group.radius_km;
}
