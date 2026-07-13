# Linear Grab

Point at any React element in your running dev app, capture a highlighted screenshot + a looping GIF of the interaction, draft a structured Linear issue with AI, delegate it to the **Cursor cloud agent** (with your repo's skills & memory), and track/steer the fix live — **without leaving your app**. Works in **any browser**: Safari, Firefox, Chrome.

Two workflows in one tool:

| Workflow | What a pick does |
|---|---|
| **Cloud · Linear + Cursor** | Opens the panel → AI-drafted issue → create + delegate → Cursor's cloud agent fixes it and opens a PR with a demo video |
| **Local · clipboard** (react-grab style) | Auto-copies the element's context (component, `file:line`, stack, your skills/memory paths) — paste into a local Claude Code / Cursor session |

---

## Install

### Next.js (script tag via CDN)

```jsx
// app/layout.tsx
import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        {process.env.NODE_ENV === "development" && (
          <Script
            src="https://cdn.jsdelivr.net/gh/ahmedbanihanibh/linear-grab@v0.10.1/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
```

> Use `afterInteractive` (not `beforeInteractive` — App Router head scripts can race hydration). Pin a tag for stability, or use `@main` to always get the latest push.

### Vite / anything with a client entry

```ts
// main.tsx — client only; the bundle is browser-only
if (import.meta.env.DEV) {
  import('linear-grab').then(({ init }) => init());
}
```

### Chrome extension (optional second distribution)

```bash
npm run build:ext   # → load .output/chrome-mv3 via chrome://extensions (Developer mode → Load unpacked)
```
Same panel as a browser side panel. Bonus: native uploads (no CORS limits) and Linear OAuth (PKCE) on top of API keys.

---

## First-run setup (panel → Settings)

1. **Workflow** — Cloud (Linear + Cursor) or Local (clipboard). Switch anytime; all settings are **per dev origin**, so every project keeps its own configuration.
2. **Linear** — paste a personal API key (linear.app → Settings → Security & access → API keys). Verifies immediately.
3. **Workspace**
   - **Default team** — where issues are created.
   - **Cursor agent** — pick Cursor from your workspace's app users. Requires the [Cursor ↔ Linear integration](https://linear.app/integrations/cursor) installed (workspace admin) and usage-based pricing enabled in Cursor.
   - **Default repository** — `owner/name`, embedded as `[repo=…]` so Cursor clones the right repo. Override per issue in the Draft tab.
   - **Cursor cloud model** — optional `[model=…]` override (e.g. `claude-opus-4-8`, `composer`).
   - **Dev server log URL** + **lines** — see *Server logs* below.
   - **Skills & memory paths** — see *Skills & memory* below.
   - **Agent instructions** — standing directives appended to every issue. Empty = the default (self-orient in the repo, computer-use testing, record a demo video, open a PR and babysit the first review round).
   - **Test account** — username/password the agent uses to log into your app while testing. Use a throwaway — it's visible to everyone who can read the issue.
4. **Asset uploads (recommended in Safari)** — a GitHub fine-grained PAT (Contents read/write) + a **public** assets repo (`owner/linear-grab-assets`). Linear's own storage rejects cross-origin browser uploads in some browsers; with this set, GIFs/screenshots upload to GitHub instead and embed automatically.
5. **AI providers** — OpenAI key (default: `gpt-5.4-nano` fast / `gpt-5.2` best) and/or Anthropic key (fallback: `claude-haiku-4-5` / `claude-opus-4-8`). Auto-resolution prefers OpenAI; runtime failures retry cross-provider. No keys = manual drafting still works.
6. **Panel** — mode (Overlay / **Beside page** — DevTools-style squeeze), dock side, and note the panel is drag-floatable and edge-resizable (300–720px).

---

## The flow (Cloud workflow)

1. **Pick** — crosshair in the launcher pill (or *Pick element*). The panel minimizes (overlay mode), the overlay highlights elements; click one. The grab publishes **instantly** (component + `file:line` from React fiber debug info — dev builds only), then a **highlighted screenshot** of the element in its container fades in (time-sliced capture — never freezes the page).
2. **Record** (optional, Capture tab) — captures the tab as a looping **GIF** (≤30s, real animated GIF). The panel minimizes; the pill shows a live clock + Stop. The browser's share dialog is a hard security requirement — Chrome preselects "This Tab" (one click).
3. **Draft** — type a rough note → **Draft with AI**. Fields stream in live following the template: *Summary → Steps to Reproduce → Expected → Actual → Impact → Analysis/Notes → Suggested Next Steps → Priority*, grounded in the captured source and your server-log tail. Edit anything inline.
4. **Create issue** — one mutation creates it and sets the Cursor agent as **delegate** (this is what triggers the cloud agent). Attached automatically: element screenshot, GIF, server logs, agent instructions (+ skills/memory pointers, test account), `[repo=…]` `[model=…]` tags. Attachment failures warn — they never block the issue.
5. **Track & steer** — **Activity** tab polls live (12s list / 8s detail): agent session status, comments (rendered markdown incl. inline images), PR links. The reply composer targets matter:
   - **Steer running agent** — threaded reply into the agent session (default when one exists). ⚠️ This is the important one: a top-level @Cursor mention **spawns a NEW cloud agent**; the threaded reply steers the one already running.
   - **Start NEW agent (@Cursor)** / **Comment only** — explicit alternatives.
6. **PRs** tab — every PR the agents linked back to your issues: state, jump-to-issue, open in Linear, copy URL.

### The launcher pill

One dock (react-grab's own toolbar is hidden): **Linear logo** (open panel) · **crosshair** (pick) · **status dot + running-agent count** — click for the **minimap** popover listing every running agent; click one to deep-link into its Activity detail. While recording, the pill becomes the stop control. Draggable; position persists.

---

## Skills & memory (make agents follow YOUR rules)

Cloud agents clone your repo — so committed skills/memory just need **authoritative pointers**, same as Claude Code via CLAUDE.md:

- **By default**, every issue tells the agent to self-orient: read `CLAUDE.md` + `AGENTS.md`, skim `.claude/memory/MEMORY.md`, load matching `.claude/skills/<name>/SKILL.md` (following symlinks into `.agents/skills/`) — skip-if-missing, safe in any repo.
- **Skills & memory paths** (Settings) adds your *load-bearing* files as MANDATORY reading per issue, e.g.:
  ```
  .claude/skills/pb-design-system/SKILL.md
  .claude/skills/apple-hig-design-principles/SKILL.md
  .claude/memory/MEMORY.md
  convex/_generated/ai/guidelines.md
  ```
- The same pointers travel in the **Local** workflow's copied context and Capture's **Copy context** button — so local Claude Code sessions get them too.
- Rule: **commit what agents must see.** Machine-local paths (`~/.claude/projects/...`) don't exist in a fresh clone.

## Server logs

Serve your dev log over HTTP and Linear Grab tails it into every issue (and feeds a 40-line tail to AI drafts for root-cause analysis):

```jsonc
// package.json
"dev:http": "next dev 2>&1 | tee public/dev-server.log"
```
```gitignore
public/dev-server.log
```
Settings → Log URL `/dev-server.log`, lines 10–500 (default 100). Per-create toggle next to the delegate checkbox.

---

## Recording actions (Capture tab)

Icon buttons: **🔗 Copy markdown** (uploads, copies `![…](url)`) · **⧉ Copy GIF** (copies the binary — paste into a Linear comment and *Linear* uploads it; the zero-setup path when direct upload is blocked) · **↓ Download** · **🗑 Discard**. Copy markdown auto-falls back to Copy GIF when the upload is blocked and no GitHub fallback is configured.

## Panel UX

- **Modes**: Overlay (floats; drag by header, double-click header to re-dock) · **Beside page** (pinned — squeezes the app next to the panel via an animated `<html>` margin; toggle via the dock icon in the header). Caveat: your app's `position: fixed` elements track the viewport and may extend under a pinned panel.
- **Resize**: drag the panel's inner edge (300–720px, persisted; pinned mode re-squeezes live).
- **Minimize** (–) collapses to the pill. New grabs reopen the panel (cloud mode).
- **Theme**: follows the host app (sampled background) — dark and light token sets.
- **Instant views**: issues/details/sessions hydrate from IndexedDB while fresh data loads.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No `file:line` on pick | Production build — React strips fiber debug info. Run the dev server. |
| "Upload to Linear storage failed" | Linear's storage rejects cross-origin browser uploads (Safari especially). Configure the **GitHub assets fallback**, use **Copy GIF → paste**, or use the extension. |
| Share dialog on every recording | Browser security requirement — cannot be bypassed. Chrome: one click ("This Tab" preselected). |
| Second Cursor agent appeared | You posted a top-level @Cursor mention. Use the composer's **Steer running agent** target (threaded reply). |
| Settings select shows placeholder | Fixed in v0.2.0+ — update your pinned version. |
| Page freezes on pick | Fixed in v0.4.2+ (time-sliced capture + worker encoding) — update your pin. |

## Security

Dev-tool only — **never load it in deployed environments** (the `NODE_ENV === "development"` gate matters). All keys (Linear, OpenAI/Anthropic, GitHub PAT) live in `localStorage` of your dev origin. Scope the GitHub PAT to the assets repo only. Test-account credentials appear in issue bodies — throwaway accounts only.

## Development

```bash
npm install
npm run dev        # Chrome extension dev mode (WXT, HMR)
npm run build:lib  # npm package → dist/ (ESM + auto-init IIFE + types)
npm run build:ext  # Chrome extension → .output/chrome-mv3
npm run build      # both
npm run compile    # typecheck
```

Stack: WXT · SolidJS · Tailwind v4 · TanStack Query/Virtual · AI SDK core · react-grab (picker engine) · gifenc (worker-side GIF encode) · html-to-image + custom time-sliced DOM capturer.
