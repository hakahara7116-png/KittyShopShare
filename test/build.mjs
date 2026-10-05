import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
// Bundles the functions with @netlify/database swapped for PGlite and stripe swapped for an in-memory fake.
export async function build(root) {
  await esbuild.build({
    entryPoints: {
      api: path.join(root, 'netlify/functions/api.ts'), hook: path.join(root, 'netlify/functions/stripe-webhook.ts'),
      bg: path.join(root, 'netlify/functions/process-background.ts'), maint: path.join(root, 'src/services/maintenance.ts'),
    },
    bundle: true, platform: 'node', format: 'esm', outdir: path.join(here, '.out'), splitting: true,
    alias: { '@netlify/database': path.join(here, 'db-shim.mjs'), stripe: path.join(here, 'stripe-fake.mjs') },
    external: ['@electric-sql/pglite', 'jose'], logLevel: 'error',
  });
}
