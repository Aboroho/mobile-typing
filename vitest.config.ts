import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mt/types': r('./packages/types/src/index.ts'),
      '@mt/validation': r('./packages/validation/src/index.ts'),
      '@mt/domain': r('./packages/domain/src/index.ts'),
      '@mt/api-client': r('./packages/api-client/src/index.ts'),
      '@mt/utils': r('./packages/utils/src/index.ts'),
      '@mt/config': r('./packages/config/src/index.ts'),
      '@': r('./apps/web'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['packages/**/*.test.ts', 'apps/web/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**', '.next/**'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20_000,
  },
});
