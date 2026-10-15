/** Unit tests may use their local HTTP server, but never external model APIs. */
import { vi } from 'vitest';
delete process.env.OPENROUTER_API_KEY;
const localFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('External fetch is disabled in unit tests. Inject a fake transport or pinFetch.');
  }
  return localFetch(input, { ...init, redirect: 'error' });
});
