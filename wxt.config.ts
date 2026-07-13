import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-solid'],
  manifest: {
    name: 'Linear Grab',
    description:
      'Point at any React element, draft a Linear issue with AI, delegate it to the Cursor agent, and track it live — without leaving the page.',
    permissions: ['storage', 'identity', 'sidePanel', 'tabs'],
    host_permissions: [
      'https://api.linear.app/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
    ],
    action: { default_title: 'Linear Grab' },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
