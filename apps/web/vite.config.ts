import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.GH_API_TARGET ?? 'http://localhost:8000';

/** `vite --mode mock` serves a tiny in-memory phase-1 API instead of proxying. */
function mockApi(): Plugin {
  return {
    name: 'gh-mock-api',
    async configureServer(server) {
      const { createMockApi } = await import('./test/mock-api');
      const mock = createMockApi({ setup: process.env.MOCK_SETUP === 'fresh' ? 'fresh' : 'finished' });
      server.middlewares.use(mock.middleware);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'mock' ? [mockApi()] : [])],
  server: {
    port: 5173,
    proxy:
      mode === 'mock'
        ? undefined
        : {
            '/api': { target: API_TARGET, changeOrigin: false },
            '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
          },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/unit/**/*.test.{ts,tsx}'],
    css: false,
  },
}));
