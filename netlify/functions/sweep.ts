import type { Config } from '@netlify/functions';
import { pollDeliveries } from '../../src/services/delivery.js';
import { cancelOverdueGroups, expireLapsedHolds, needsProcessor, settleUnfilledGroups } from '../../src/services/maintenance.js';
import { kickProcessor } from '../../src/services/tasks.js';

// Scheduled, every 10 minutes. Scheduled functions have a 30 second limit, so heavy work is handed to the background processor.
export default async (_req: Request) => {
  const unfilled = await settleUnfilledGroups();
  const cancelled = await cancelOverdueGroups();
  const lapsed = await expireLapsedHolds();
  if (await needsProcessor()) await kickProcessor(process.env.URL ?? '');
  await pollDeliveries(10);
  console.log('sweep', { unfilled, cancelled, lapsed });
};

export const config: Config = { schedule: '*/10 * * * *' };
