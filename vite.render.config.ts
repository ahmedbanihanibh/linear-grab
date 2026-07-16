import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * Standalone render-scan IIFE for the bridge's headless `audit --renders` — the
 * re-render sibling of vite.slop.config.ts. Injected into audited pages via CDP
 * (addScriptToEvaluateOnNewDocument) so it must be self-contained: the pure
 * render engine (renderScan + renderRulebook) plus the one impure recorder
 * (fiberCommits), with bippy INLINED (a direct dep — fine here). No solid /
 * panel / react-grab: react-grab is borrowed off window.__REACT_GRAB__ at runtime.
 *
 * Runs after the other lib builds (emptyOutDir: false appends to dist/); the
 * build script then copies dist/render-scan.global.js into packages/bridge/ and
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
      entry: 'src/lib/renderScanStandalone.ts',
      formats: ['iife'],
      name: 'RenderScan',
      fileName: () => 'render-scan.global.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
