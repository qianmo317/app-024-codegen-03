import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
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
  test: {
    // 单元测试只跑 tests/*.test.ts；tests/e2e 由 Playwright 负责（npm run e2e）
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
});
