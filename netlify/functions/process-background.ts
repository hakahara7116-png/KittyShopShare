import type { Context } from '@netlify/functions';
import { q } from '../../src/lib/db.js';
import { env } from '../../src/lib/env.js';
import { runCapture, runCompensation } from '../../src/services/capture.js';
import { processPending } from '../../src/services/events.js';

// Background function (the -background suffix): Netlify answers 202 at once and runs this for up to 15 minutes.
export default async (req: Request, _context: Context) => {
  if (req.headers.get('x-internal-secret') !== env('INTERNAL_TASK_SECRET')) return;
  const stopAt = Date.now() + 13 * 60_000;
  const ready = new Set<string>();
  while (Date.now() < stopAt) {
    const r = await processPending(50);
    r.ready.forEach(id => ready.add(id));
    if (r.processed === 0) break;
  }
  const stuck = await q(`SELECT id, status FROM group_order
    WHERE (status = 'capturing' AND (capture_started_at IS NULL OR capture_started_at < now() - interval '10 minutes'))
       OR (status = 'compensating' AND updated_at < now() - interval '10 minutes') LIMIT 25`);
  for (const g of stuck) if (g.status === 'capturing') ready.add(g.id);
  for (const id of ready) {
    if (Date.now() > stopAt) break;
    try { console.log('capture', id, await runCapture(id)); } catch (e) { console.error('capture failed to run', id, e); }
  }
  for (const g of stuck.filter(g => g.status === 'compensating')) {
    try { await runCompensation(g.id); } catch (e) { console.error('compensation failed to run', g.id, e); }
  }
};
