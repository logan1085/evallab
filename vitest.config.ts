import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': root + 'shared',
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Route tests seat a panel and grade through the simulation; under a
    // full parallel run that can pass ten seconds on a loaded machine.
    testTimeout: 30_000,
  },
});
