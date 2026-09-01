import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './app.js';
import { openDb, resolveConnection } from './db.js';
import { PIN_OVERRIDES, pinEnvKey, validatePins } from './pins.js';

const port = Number(process.env.PORT ?? 8787);
const conn = resolveConnection();
const db = await openDb();
const app = createApp(db);

if (conn.url) {
  console.log(`Postgres via ${conn.via}${conn.pooled ? ' (pooled)' : ''}.`);
} else {
  console.log('No DATABASE_URL set: using in-memory Postgres. Every project is lost when this process ends.');
}

// In production the built SPA is served from the same origin, so a shared link
// is one URL with no CORS story to get wrong.
const here = dirname(fileURLToPath(import.meta.url));
const webDir = [resolve(here, 'web'), resolve(here, '..', 'dist', 'web')].find((dir) =>
  existsSync(join(dir, 'index.html')),
);

if (webDir) {
  app.use(express.static(webDir));
  // /s/* is the server-rendered Standards page, not the SPA.
  app.get(/^(?!\/(?:api|s)\/).*/, (_req, res) => res.sendFile(join(webDir, 'index.html')));
}

const server = app.listen(port, () => {
  const mode = webDir ? 'app + api' : 'api only (run `npm run dev:web` for the UI)';
  console.log(`The Grading Room: ${mode} on http://localhost:${port}`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('No OPENROUTER_API_KEY set: the panel runs as the labeled simulation, which is not judgment.');
  } else {
    // Every pinned id, checked against the router's own list at boot. A pin
    // that is not a model is a 400 on first use, and finding that at startup
    // beats finding it when someone clicks a button.
    for (const o of PIN_OVERRIDES) console.log(`Pin ${o.pin_id} repinned by ${pinEnvKey(o.pin_id)}: ${o.from} -> ${o.to}`);
    void validatePins(fetch, { disableInvalid: true }).then((result) => {
      if (result.ok) {
        console.log(`Pins: all ${result.checked} live model ids resolve against openrouter.ai.`);
        return;
      }
      console.error('PINS INVALID. Model calls using these would fail:');
      for (const problem of result.problems) console.error(`  ${problem}`);
      if (result.disabled.length > 0) {
        console.error(`Stood down for this process: ${result.disabled.join(', ')}. The panel runs on the families that remain.`);
      }
      console.error('Fix them in server/pins.ts, or run npm run pins:check for the full list.');
    });
  }
});

/**
 * A backstop, not a strategy. Routes forward their own failures now, but an
 * unhandled rejection from anywhere else should still not silently kill a
 * server that is holding requests: it is logged and the process keeps serving.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection, still serving:', reason);
});

/**
 * Finish in-flight requests before closing the database. A grader submitting a
 * verdict during a deploy should get their verdict stored, not a dropped
 * connection — and ending the pool underneath an open request loses that write.
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

    server.close(async (err) => {
      try {
        await db.close();
      } catch {
        // Already closed; nothing to salvage.
      }
      process.exit(err ? 1 : 0);
    });
  });
}
