import { render } from 'solid-js/web';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import App, { LinearLogo } from '@/panel/App';
import { ensurePagePicker } from '@/lib/picker';
import { getSettings, saveSettings, subscribeStorage } from '@/lib/storage';
import { subscribeRunningAgents, type RunningAgentIssue } from '@/lib/agentWatch';
import { getRecorderSnapshot, subscribeRecorder, stopRecording } from '@/lib/recorder';
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
const PANEL_W = 380;

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
  const [recPhase, setRecPhase] = createSignal(getRecorderSnapshot().phase);
  const [recElapsed, setRecElapsed] = createSignal(0);

  // Live elapsed readout in the pill while recording.
  onMount(() => {
    const iv = setInterval(() => {
      if (recPhase() === 'recording') {
        setRecElapsed(Date.now() - (getRecorderSnapshot().startedAt ?? Date.now()));
      }
    }, 250);
    onCleanup(() => clearInterval(iv));
  });

  const fmtElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  // Free-floating panel position; null = docked to the configured side.
  const [panelPos, setPanelPos] = createSignal<{ x: number; y: number } | null>(null);

  const clamp = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(8, p.x), window.innerWidth - PILL_W - 8),
    y: Math.min(Math.max(8, p.y), window.innerHeight - PILL_H - 8),
  });

  const clampPanel = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(8 - (PANEL_W - 80), p.x), window.innerWidth - 80),
    y: Math.min(Math.max(0, p.y), window.innerHeight - 80),
  });

  onMount(() => {
    void getSettings().then((s) => {
      if (s.panelSide) setSide(s.panelSide);
      if (s.launcherPos) setPos(clamp(s.launcherPos));
      if (s.panelPos) setPanelPos(clampPanel(s.panelPos));
    });
    const unsubSettings = subscribeStorage((area) => {
      if (area === 'settings') void getSettings().then((s) => setSide(s.panelSide ?? 'right'));
      // App unmounts while closed (so Activity polling stops) — reopen on new grabs.
      if (area === 'grab') setOpen(true);
    });
    const unsubAgents = subscribeRunningAgents(setRunning);

    // Recording choreography: minimize while capturing so the recording shows
    // the APP (not our panel); the pill becomes the stop control; reopen on
    // the Capture tab when the GIF is ready.
    let prevPhase = getRecorderSnapshot().phase;
    const unsubRec = subscribeRecorder((snap) => {
      setRecPhase(snap.phase);
      if (snap.phase === 'recording' && prevPhase !== 'recording') {
        setOpen(false);
      }
      if (snap.phase === 'ready' && prevPhase !== 'ready') {
        openPanelTo('capture');
        setOpen(true);
      }
      prevPhase = snap.phase;
    });

    const onResize = () => {
      setPos(clamp(pos()));
      const pp = panelPos();
      if (pp) setPanelPos(clampPanel(pp));
    };
    window.addEventListener('resize', onResize);
    onCleanup(() => {
      unsubSettings();
      unsubAgents();
      unsubRec();
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

  // Panel drag (header = handle). Double-click the header to re-dock.
  const onPanelPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (e.detail === 2) {
      setPanelPos(null);
      void saveSettings({ panelPos: undefined });
      return;
    }
    const start = { x: e.clientX, y: e.clientY };
    const origin =
      panelPos() ?? { x: side() === 'right' ? window.innerWidth - PANEL_W : 0, y: 0 };
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) setPanelPos(clampPanel({ x: origin.x + dx, y: origin.y + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const pp = panelPos();
      if (moved && pp) void saveSettings({ panelPos: pp });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
            <Show
              when={recPhase() === 'recording'}
              fallback={
                <>
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
                </>
              }
            >
              {/* Recording mode: the panel is minimized so the capture shows the
                  app — the pill is the stop control with a live clock. */}
              <span aria-hidden class="bg-danger size-2 shrink-0 animate-pulse rounded-full" />
              <span class="text-text min-w-[5ch] text-[11px] font-medium tabular-nums">
                {fmtElapsed(recElapsed())}
              </span>
              <button
                onClick={() => {
                  if (dragMoved) return;
                  void stopRecording();
                }}
                class="bg-accent hover:bg-accent-hover h-7 cursor-pointer rounded-full px-2.5 text-[11px] font-medium text-white transition-colors"
              >
                <span class="inline-block min-w-[4ch] text-center">Stop</span>
              </button>
            </Show>
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
          class={`bg-bg text-text border-border fixed z-[2147483645] flex w-[380px] max-w-[100vw] flex-col overflow-hidden font-sans text-[13px] antialiased shadow-2xl ${
            panelPos()
              ? 'rounded-xl border'
              : side() === 'right'
                ? 'top-0 right-0 h-screen border-l'
                : 'top-0 left-0 h-screen border-r'
          }`}
          style={
            panelPos()
              ? {
                  left: `${panelPos()!.x}px`,
                  top: `${panelPos()!.y}px`,
                  height: `${Math.min(680, window.innerHeight - 16)}px`,
                }
              : undefined
          }
        >
          {/* Drag the header to float the panel anywhere; double-click to re-dock. */}
          <App
            onGrab={() => setOpen(true)}
            onClose={() => setOpen(false)}
            onHeaderPointerDown={onPanelPointerDown}
          />
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
