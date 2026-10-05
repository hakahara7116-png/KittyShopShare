import { env } from '../lib/env.js';

/** Starts the background processor. Background functions answer 202 immediately and run for up to 15 minutes. */
export async function kickProcessor(origin: string) {
  try {
    await fetch(`${origin}/.netlify/functions/process-background`, { method: 'POST', headers: { 'x-internal-secret': env('INTERNAL_TASK_SECRET') } });
  } catch (e) { console.error('could not start background processor; the sweep will pick it up', e); }
}
