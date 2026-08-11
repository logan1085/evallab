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
import { openDb } from '../server/db.js';

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

export default async function handler(req: IncomingMessage, res: ServerResponse) {
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
