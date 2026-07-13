import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

/**
 * Library build — the react-grab-style npm distribution. Produces a single
 * self-contained ESM file users import in their dev entry:
 *
 *   if (import.meta.env.DEV) import('linear-grab').then(({ init }) => init());
 *
 * Everything (Solid, react-grab, AI SDK, compiled CSS) is bundled so the host
 * project needs zero peer deps. The Chrome extension build (wxt.config.ts) is
 * separate and unaffected.
 */
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    // Dev-tool bundle shipped as-is; pin NODE_ENV so deps don't leave
    // process.env references behind in the browser.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/page/index.tsx',
      formats: ['es'],
      fileName: () => 'linear-grab.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
