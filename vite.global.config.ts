import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

/**
 * Script-tag build — IIFE that auto-inits, served via unpkg like react-grab:
 *
 *   <Script src="//unpkg.com/linear-grab/dist/index.global.js"
 *           strategy="beforeInteractive" />
 *
 * Runs AFTER the ESM lib build (emptyOutDir: false appends to dist/).
 */
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/page/global.ts',
      formats: ['iife'],
      name: 'LinearGrab',
      fileName: () => 'index.global.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
