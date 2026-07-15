import { defineConfig } from 'vitest/config';

// Minimal, standalone unit-test config — deliberately separate from the two
// vite build configs (vite.lib / vite.global) so the extension build is
// untouched. happy-dom gives us a DOM without a layout engine (rects are
// zeros); layout-dependent rules are driven via stubMetrics in the fixtures.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
