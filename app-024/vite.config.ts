import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  test: {
    // e2e 由 Playwright 运行（npm run e2e），不进入 vitest
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5104,
  },
});
