import { HttpError } from './http.js';

export interface Point { lat: number; lng: number }
export const RADII_KM = [2, 5, 10, 25, 50];

/** Rounds to 2 decimals (about 1.1 km): enough to find neighbors, not enough to find a door. */
export const coarse = (v: number) => Math.round(v * 100) / 100;

export function readPoint(input: any, required = true): Point | null {
  const lat = Number(input?.lat), lng = Number(input?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    if (required) throw new HttpError(400, 'Share your location or set your area first.');
    return null;
  }
  return { lat: coarse(lat), lng: coarse(lng) };
}
export function readRadius(v: unknown, fallback = 10): number {
  if (v === null || v === undefined || v === '') return fallback; // Number(null) is 0, which would shrink the area to 1 km
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : fallback;
}
export function haversineKm(a: Point, b: Point): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
/** SQL distance in km from ($latIdx, $lngIdx) to the given columns. Plain SQL, no PostGIS needed. */
export const sqlDistance = (latIdx: number, lngIdx: number, latCol = 'g.lat', lngCol = 'g.lng') =>
  `(6371 * 2 * asin(sqrt(power(sin(radians(${latCol} - $${latIdx}) / 2), 2) + cos(radians($${latIdx})) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - $${lngIdx}) / 2), 2))))`;
/** Index-friendly bounding box around a point. */
export const sqlBox = (latIdx: number, lngIdx: number, kmIdx: number, latCol = 'g.lat', lngCol = 'g.lng') =>
  `(${latCol} BETWEEN $${latIdx} - $${kmIdx} / 111.0 AND $${latIdx} + $${kmIdx} / 111.0
    AND ${lngCol} BETWEEN $${lngIdx} - $${kmIdx} / (111.0 * GREATEST(cos(radians($${latIdx})), 0.01)) AND $${lngIdx} + $${kmIdx} / (111.0 * GREATEST(cos(radians($${latIdx})), 0.01)))`;
/** Shown to other people instead of coordinates. */
export const roundDistance = (km: number) => (km < 1 ? 1 : Math.round(km * 2) / 2);

/** Optional: turns a postal code or neighborhood into coordinates. Mapbox if MAPBOX_TOKEN is set. */
export async function geocode(query: string): Promise<(Point & { label: string }) | null> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new HttpError(501, 'Searching by postal code isn’t set up. Use “Share my location” instead.');
  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query)}&limit=1&access_token=${token}`;
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(502, 'Location search failed. Try again.');
  const f = (await r.json() as any).features?.[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  return { lat: coarse(lat), lng: coarse(lng), label: String(f.properties?.name ?? query).slice(0, 60) };
}
export const geocoderAvailable = () => !!process.env.MAPBOX_TOKEN;
