import { getDatabase } from '@netlify/database';

// One connection per function instance, reused across invocations.
let conn: ReturnType<typeof getDatabase> | null = null;
const database = () => (conn ??= getDatabase());

export interface Tx { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await (database().pool as any).query(text, params);
  return r.rows as T[];
}
export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}
export async function tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await (database().pool as any).connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
