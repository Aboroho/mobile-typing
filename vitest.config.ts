import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mt/types': r('./lib/types/index.ts'),
      '@mt/validation': r('./lib/validation/index.ts'),
      '@mt/domain': r('./lib/domain/index.ts'),
      '@mt/api-client': r('./lib/api-client/index.ts'),
      '@mt/utils': r('./lib/utils/index.ts'),
      '@mt/config': r('./lib/config/index.ts'),
      '@': r('./'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**', '.next/**', 'apps/**', 'packages/**'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20_000,
  },
});
