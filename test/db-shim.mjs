// Stands in for @netlify/database: a single PGlite connection behind a pg-like pool.
import { PGlite } from '@electric-sql/pglite';
export const pg = (globalThis.__pg ??= new PGlite());
let chain = Promise.resolve();
const client = {
  query: (text, params = []) => pg.query(text, params).then(r => ({ rows: r.rows })),
  release() {},
};
// serialize "connections" so transactions don't interleave on the single PGlite session
const pool = {
  query: (t, p) => client.query(t, p),
  connect: () => { let release; const next = new Promise(r => (release = r)); const prev = chain; chain = chain.then(() => next); return prev.then(() => ({ ...client, release })); },
};
export function getDatabase() { return { pool }; }
