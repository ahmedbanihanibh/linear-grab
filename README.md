# Linear Grab

Point at any React element in your running dev app, record the interaction as a GIF, draft a Linear issue with AI, delegate it to the **Cursor agent**, and track/steer the fix live — without leaving your app. Works in **any browser** (Safari, Firefox, Chrome).

## Install (script tag — Next.js)

```jsx
import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        {process.env.NODE_ENV === "development" && (
          <Script
            src="https://cdn.jsdelivr.net/gh/ahmedbanihanibh/linear-grab@v0.7.2/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
```

Once published to npm, unpkg also works:
`//unpkg.com/linear-grab/dist/index.global.js`

## Install (npm — Vite & friends)

```ts
// main.tsx — client entry only (the bundle is browser-only)
if (import.meta.env.DEV) {
  import('linear-grab').then(({ init }) => init());
}
```

## Setup (once, in the panel)

1. Click the floating **LG** launcher → **Settings**.
2. Paste a Linear **personal API key** (linear.app → Settings → Security & access → API keys).
3. Pick your default **team** and the **Cursor agent** (requires the [Cursor integration](https://linear.app/integrations/cursor) installed in your Linear workspace).
4. Add an **OpenAI** key (default, `gpt-5.4-nano` fast / `gpt-5.2` best) and/or **Anthropic** key (fallback, `claude-haiku-4-5` / `claude-opus-4-8`).
5. Set the default **repository** (`owner/name`) — embedded as `[repo=…]` so Cursor works in the right repo.

## Flow

1. **Pick element** — the overlay resolves the clicked element to its source (`Component` + `file:line`) via React fiber debug info. Dev builds only.
2. **Record interaction** (optional) — captures your screen as a looping GIF (≤30s) so the coding agent can *watch* the bug. Attach to the issue, copy as markdown, or download.
3. **Draft with AI** — your rough note + captured context stream into a structured issue (title, repro, expected/actual, priority). Edit anything inline.
4. **Create issue** — one mutation creates it and sets the Cursor agent as delegate; Cursor's cloud agent clones the repo, fixes, and opens a PR with demo artifacts.
5. **Activity** — live registry of your issues: agent session status, PR links, comments. Reply with an @-mention to steer the running agent.

## Security

Dev-tool only. API keys are stored in `localStorage` of your dev origin — always gate the script/import on `NODE_ENV === "development"` and never load it in deployed environments.

## Chrome extension (optional second distribution)

The same panel also ships as a Chrome MV3 side-panel extension: `npm run build:ext` → load `.output/chrome-mv3` via `chrome://extensions`. Adds Linear OAuth (PKCE) support on top of API keys.

## Development

```bash
npm install
npm run dev        # extension dev mode (WXT)
npm run build:lib  # npm package → dist/ (ESM + auto-init IIFE + types)
npm run build:ext  # Chrome extension → .output/chrome-mv3
npm run compile    # typecheck
```
