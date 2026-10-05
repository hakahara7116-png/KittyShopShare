import type { User } from '../lib/auth.js';
import { q, type Tx } from '../lib/db.js';

export type Kind = 'similar_group' | 'nearby_group' | 'checkout_needed' | 'hold_expired' | 'group_cancelled';
export interface Note { userId: string; kind: Kind; groupId: string; relatedGroupId?: string | null; title: string; body: string }

/** In-app notifications, delivered once per (user, kind, group, related group). */
export async function notify(notes: Note[], c?: Tx) {
  if (!notes.length) return;
  const exec = c ? (t: string, p: unknown[]) => c.query(t, p) : (t: string, p: unknown[]) => q(t, p);
  for (let i = 0; i < notes.length; i += 200) {
    const chunk = notes.slice(i, i + 200), params: unknown[] = [];
    const rows = chunk.map((n, k) => {
      params.push(n.userId, n.kind, n.groupId, n.relatedGroupId ?? null, n.title, n.body);
      const b = k * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await exec(`INSERT INTO notification (user_id, kind, group_order_id, related_group_id, title, body) VALUES ${rows.join(', ')} ON CONFLICT DO NOTHING`, params);
  }
}
export async function inbox(user: User) {
  const items = await q(`SELECT id, kind, group_order_id AS "groupId", related_group_id AS "relatedGroupId", title, body, created_at AS "createdAt", read_at IS NOT NULL AS read
    FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`, [user.id]);
  const [{ unread }] = await q(`SELECT count(*)::int AS unread FROM notification WHERE user_id = $1 AND read_at IS NULL`, [user.id]);
  return { unread, items };
}
export async function markRead(user: User, ids?: unknown) {
  if (Array.isArray(ids) && ids.length) await q(`UPDATE notification SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`, [user.id, ids.map(Number).filter(Number.isFinite)]);
  else await q(`UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [user.id]);
  return { ok: true };
}
