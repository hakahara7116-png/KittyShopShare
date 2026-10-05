import type { Config, Context } from '@netlify/functions';
import { errorResponse, json } from '../../src/lib/http.js';
import { ingest } from '../../src/services/events.js';
import { kickProcessor } from '../../src/services/tasks.js';

// Verify, store once, answer fast. Stripe retries anything that isn't a 2xx.
export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const raw = await req.text(); // the exact bytes are needed for signature verification
    const { stored } = await ingest('stripe', req.headers, raw);
    if (stored) await kickProcessor(new URL(req.url).origin);
    return json({ received: true });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config: Config = { path: '/webhooks/stripe' };
