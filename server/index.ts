import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 8787);
const db = openDb();
const app = createApp(db);

// In production the built SPA is served from the same origin, so a shared link
// is one URL with no CORS story to get wrong.
const here = dirname(fileURLToPath(import.meta.url));
const webDir = [resolve(here, 'web'), resolve(here, '..', 'dist', 'web')].find((dir) =>
  existsSync(join(dir, 'index.html')),
);

if (webDir) {
  app.use(express.static(webDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(webDir, 'index.html')));
}

const server = app.listen(port, () => {
  const mode = webDir ? 'app + api' : 'api only (run `npm run dev:web` for the UI)';
  console.log(`The Grading Room — ${mode} on http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set: judge runs will use the offline stub, which is not a real judge.');
  }
});

/**
 * Finish in-flight requests before closing the database. A grader submitting a
 * verdict during a deploy should get their verdict stored, not a dropped
 * connection — and closing SQLite underneath an open request corrupts nothing
 * but does lose that write.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, finishing in-flight requests…`);

    const force = setTimeout(() => {
      console.error('Shutdown timed out after 10s, exiting anyway.');
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close((err) => {
      try {
        db.close();
      } catch {
        // Already closed; nothing to salvage.
      }
      process.exit(err ? 1 : 0);
    });
  });
}
