import { render } from 'solid-js/web';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import App, { LinearLogo } from '@/panel/App';
import { ensurePagePicker } from '@/lib/picker';
import { getSettings, saveSettings, subscribeStorage } from '@/lib/storage';
import { subscribeRunningAgents, type RunningAgentIssue } from '@/lib/agentWatch';
import { openPanelTo } from '@/panel/nav';
// Compiled Tailwind CSS as a string — injected into the shadow root so the
// host app's styles and ours never collide.
import cssText from '@/styles/app.css?inline';

export interface InitOptions {
  /** Open the panel immediately instead of waiting for the launcher click. */
  defaultOpen?: boolean;
}

declare global {
  interface Window {
    __LINEAR_GRAB_PAGE__?: boolean;
  }
}

/**
 * Page-mode entry — the react-grab distribution model. Add to any project:
 *
 *   if (import.meta.env.DEV) {
 *     import('linear-grab').then(({ init }) => init());
 *   }
 *
 * Mounts the full panel (draft / activity / PRs / settings) in a shadow root
 * inside the host app. Works in ANY browser — Safari, Firefox, Chrome.
 * Dev use only: keys are stored in localStorage of the dev origin.
 */
export function init(options: InitOptions = {}): void {
  if (typeof window === 'undefined') return; // SSR guard
  if (window.__LINEAR_GRAB_PAGE__) return; // double-init guard
  window.__LINEAR_GRAB_PAGE__ = true;

  const mount = () => {
    void ensurePagePicker();

    const host = document.createElement('div');
    host.id = 'linear-grab-root';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);

    const root = document.createElement('div');
    shadow.appendChild(root);

    // Theme follows the HOST APP (sampled background), not just the OS — a
    // dark dev app on a light OS should get the dark panel, like react-grab.
    const applyTheme = () => root.setAttribute('data-theme', detectTheme());
    applyTheme();
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

    render(() => <PagePanel defaultOpen={options.defaultOpen ?? false} />, root);
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

function detectTheme(): 'light' | 'dark' {
  try {
    const probe = [document.body, document.documentElement];
    for (const el of probe) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
      if (!m || (m[4] !== undefined && Number(m[4]) === 0)) continue;
      const luminance = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
      return luminance > 140 ? 'light' : 'dark';
    }
  } catch {
    /* fall through */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const PILL_W = 130;
const PILL_H = 36;

/** Floating launcher pill (react-grab-style) + docked panel hosting the shared App. */
function PagePanel(props: { defaultOpen: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen);
  const [side, setSide] = createSignal<'left' | 'right'>('right');
  const [pos, setPos] = createSignal({
    x: Math.max(8, window.innerWidth - PILL_W - 24),
    y: Math.max(8, window.innerHeight - PILL_H - 20),
  });
  const [running, setRunning] = createSignal<RunningAgentIssue[]>([]);
  const [minimapOpen, setMinimapOpen] = createSignal(false);

  const clamp = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(8, p.x), window.innerWidth - PILL_W - 8),
    y: Math.min(Math.max(8, p.y), window.innerHeight - PILL_H - 8),
  });

  onMount(() => {
    void getSettings().then((s) => {
      if (s.panelSide) setSide(s.panelSide);
      if (s.launcherPos) setPos(clamp(s.launcherPos));
    });
    const unsubSettings = subscribeStorage((area) => {
      if (area === 'settings') void getSettings().then((s) => setSide(s.panelSide ?? 'right'));
      // App unmounts while closed (so Activity polling stops) — reopen on new grabs.
      if (area === 'grab') setOpen(true);
    });
    const unsubAgents = subscribeRunningAgents(setRunning);
    const onResize = () => setPos(clamp(pos()));
    window.addEventListener('resize', onResize);
    onCleanup(() => {
      unsubSettings();
      unsubAgents();
      window.removeEventListener('resize', onResize);
    });
  });

  // Drag-to-move: the pill must be parkable anywhere so it never covers app UI.
  let dragMoved = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const startPos = pos();
    dragMoved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
      if (dragMoved) setPos(clamp({ x: startPos.x + dx, y: startPos.y + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (dragMoved) void saveSettings({ launcherPos: pos() });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const showMinimapAbove = () => pos().y > 260;

  return (
    <>
      {/* Launcher pill — hidden while the panel is open (the panel has its own
          close button), so it can never cover panel controls again. */}
      <Show when={!open()}>
        <div
          class="fixed z-[2147483646] select-none"
          style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        >
          <div
            onPointerDown={onPointerDown}
            class="bg-surface border-border text-text flex h-9 cursor-grab items-center gap-1 rounded-full border py-1 pr-1 pl-2.5 font-sans shadow-lg active:cursor-grabbing"
          >
            <button
              onClick={() => {
                if (dragMoved) return;
                setMinimapOpen(false);
                setOpen(true);
              }}
              title="Open Linear Grab"
              aria-label="Open Linear Grab"
              class="text-accent hover:opacity-80 inline-flex cursor-pointer items-center gap-1.5"
            >
              <LinearLogo size={13} />
            </button>
            <span class="bg-border h-4 w-px" aria-hidden />
            {/* Live agent status — dot pulses while agents run; count is fixed-width. */}
            <button
              onClick={() => {
                if (dragMoved) return;
                setMinimapOpen((v) => !v);
              }}
              title="Running agents"
              aria-label="Running agents"
              class="hover:bg-surface-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2 transition-colors"
            >
              <span
                aria-hidden
                class={`size-2 rounded-full ${
                  running().length ? 'bg-success animate-pulse' : 'bg-text-faint'
                }`}
              />
              <span class="text-text-dim min-w-[3.5ch] text-left text-[11px] font-medium tabular-nums">
                {running().length} run
              </span>
            </button>
          </div>

          {/* Minimap popover — the running agents at a glance. */}
          <Show when={minimapOpen()}>
            <div
              class={`bg-surface border-border absolute w-72 rounded-lg border p-1.5 font-sans shadow-2xl ${
                showMinimapAbove() ? 'bottom-full mb-2' : 'top-full mt-2'
              } ${pos().x > window.innerWidth - 300 ? 'right-0' : 'left-0'}`}
            >
              <p class="text-text-dim px-1.5 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-wide uppercase">
                Running agents
              </p>
              <Show
                when={running().length > 0}
                fallback={
                  <p class="text-text-faint px-1.5 pb-1.5 text-[11.5px]">
                    No agents running right now.
                  </p>
                }
              >
                <For each={running()}>
                  {(agent) => (
                    <button
                      onClick={() => {
                        setMinimapOpen(false);
                        openPanelTo('activity', agent.id);
                        setOpen(true);
                      }}
                      class="hover:bg-surface-2 flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors"
                    >
                      <span class="flex min-w-0 items-center gap-1.5">
                        <span
                          aria-hidden
                          class="size-1.5 shrink-0 rounded-full"
                          style={{ background: agent.stateColor }}
                        />
                        <span class="font-mono text-text-dim shrink-0 text-[10.5px]">
                          {agent.identifier}
                        </span>
                        <span class="text-text truncate text-[11.5px]">{agent.title}</span>
                      </span>
                      <span class="text-text-faint pl-3 text-[10.5px] tabular-nums">
                        {agent.delegateName} · {agent.stateName} · {timeAgoShort(agent.updatedAt)}
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={open()}>
        <div
          class={`bg-bg text-text fixed top-0 z-[2147483645] flex h-screen w-[380px] max-w-[100vw] flex-col font-sans text-[13px] antialiased shadow-2xl ${
            side() === 'right' ? 'border-border right-0 border-l' : 'border-border left-0 border-r'
          }`}
        >
          <App onGrab={() => setOpen(true)} onClose={() => setOpen(false)} />
        </div>
      </Show>
    </>
  );
}

function timeAgoShort(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
