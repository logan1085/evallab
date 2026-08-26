/**
 * Vercel serverless entry. Everything under /api/* arrives here.
 *
 * Two things matter in this file, and both are about the platform rather than
 * the product.
 *
 * The app and the connection pool are built once per instance, not once per
 * request. Vercel keeps a warm instance alive between invocations, so a
 * module-scoped promise means the second request through a given instance pays
 * neither the Postgres handshake nor the schema check. Building them inside the
 * handler would open a new pool per request and exhaust the pooler under any
 * real load.
 *
 * The promise is also the failure boundary: if the first connection attempt
 * fails, it is cleared so the next request retries rather than every subsequent
 * request replaying one dead connection for the life of the instance.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';
import { openDb, resolveConnection } from '../server/db.js';

let cached: Promise<ReturnType<typeof createApp>> | null = null;

function app() {
  if (!cached) {
    cached = openDb()
      .then(createApp)
      .catch((error) => {
        cached = null;
        throw error;
      });
  }
  return cached;
}

/**
 * The in-memory fallback that makes `npm run dev` work with nothing installed
 * is a data-loss bug in production: each serverless instance gets its own
 * empty database, so a project created on one instance does not exist on the
 * next, and every secret link dies on reload. Refusing every write-path
 * request with the fix spelled out beats losing someone's project silently.
 * /api/health stays reachable so the misconfiguration is diagnosable.
 */
const NO_DB =
  'This deployment has no database, so nothing can be saved. In Vercel: Storage, then Create Database, then Neon Postgres. That sets DATABASE_URL automatically; redeploy and this message goes away.';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '').split('?')[0] ?? '';
  // Health and the docs stay readable without a database: one diagnoses the
  // misconfiguration, the other never needed a database in the first place.
  const readableAnyway = /^\/api(\/v1)?\/(health|docs)$/.test(path);
  if (process.env.VERCEL && !resolveConnection().url && !readableAnyway) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: NO_DB }));
    return;
  }
  try {
    (await app())(req, res);
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error:
          error instanceof Error && /DATABASE_URL|connect|password|ENOTFOUND/i.test(error.message)
            ? 'The database is not reachable. Check DATABASE_URL in the project settings.'
            : 'The API could not start.',
      }),
    );
  }
}
