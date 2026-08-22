import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // third_party is a byte-for-byte upstream audit snapshot, not this
  // workspace's test target. Its own toolchain is intentionally not merged.
  test: { environment: 'jsdom', include: ['**/*.test.ts'], exclude: ['third_party/**', '**/node_modules/**', '**/dist/**'] },
  resolve: {
    alias: {
      '@workbench/contracts': resolve('packages/contracts/src'),
      '@workbench/selector-engine': resolve('packages/selector-engine/src'),
      '@workbench/patch-engine': resolve('packages/patch-engine/src'),
      '@workbench/scheme-store': resolve('packages/scheme-store/src')
    }
  }
});
