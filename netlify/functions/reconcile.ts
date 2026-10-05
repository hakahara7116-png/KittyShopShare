import type { Config } from '@netlify/functions';
import { reconcile } from '../../src/services/maintenance.js';

// Scheduled, daily at 07:00 UTC: compare the ledger with what the provider reports.
export default async (_req: Request) => {
  console.log('reconciliation', await reconcile(40));
};

export const config: Config = { schedule: '0 7 * * *' };
