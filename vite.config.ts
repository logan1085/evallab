import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react(), {
    name: 'deployment-identity',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: { name: 'build-commit', content: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' },
      injectTo: 'head',
    }],
  }],
  resolve: {
    alias: {
      '@shared': root + 'shared',
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
