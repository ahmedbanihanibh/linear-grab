import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * Standalone slop-scan IIFE for the bridge's headless `audit` command —
 * injected into audited pages via CDP, so it must be self-contained and tiny
 * (pure engine only: slopScan + cssShared, no solid/panel/react-grab).
 *
 * Runs after the other lib builds (emptyOutDir: false appends to dist/); the
 * build script then copies dist/slop-scan.global.js into packages/bridge/ and
 * bin/ so the published bridge carries its own copy.
 */
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.VITE_LG_VERSION': JSON.stringify(version),
  },
  build: {
    lib: {
      entry: 'src/lib/slopScanStandalone.ts',
      formats: ['iife'],
      name: 'SlopScan',
      fileName: () => 'slop-scan.global.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
