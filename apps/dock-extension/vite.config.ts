import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const entry = resolve(
    __dirname,
    mode === 'background'
      ? 'src/background/index.ts'
      : mode === 'local-preview'
        ? 'src/local-preview/main.ts'
      : mode === 'workspace'
        ? 'src/workspace/main.ts'
        : 'src/content/dock-entry.ts',
  );

  return {
    resolve: {
      alias: {
        '@workbench/selector-engine': resolve(__dirname, '../../packages/selector-engine/src'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: mode === 'content',
      lib: {
        entry,
        formats: ['iife'],
        name:
          mode === 'background'
            ? 'DockBackground'
            : mode === 'local-preview'
              ? 'DianjingLocalPreview'
            : mode === 'workspace'
              ? 'DianjingWorkspace'
              : 'DockContent',
      },
      rollupOptions: {
        output: {
          entryFileNames: `${mode}.js`,
          assetFileNames: (assetInfo) =>
            assetInfo.names?.some((name) => name.endsWith('.css'))
              ? 'workspace.css'
              : 'assets/[name][extname]',
        },
      },
    },
  };
});
