import { render } from 'solid-js/web';
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import App, { LinearLogo } from '@/panel/App';
import { ensurePagePicker, CONTEXT_COPIED_EVENT, PICKER_ACTIVATED_EVENT } from '@/lib/picker';
import { installConsoleCapture } from '@/lib/consoleCapture';
import { getSettings, saveSettings, subscribeStorage } from '@/lib/storage';
import {
  subscribeRunningAgents,
  type AgentWatchSnapshot,
  type RunningAgentIssue,
} from '@/lib/agentWatch';
import { getRecorderSnapshot, subscribeRecorder, stopRecording } from '@/lib/recorder';
import { subscribeGenomeCapture, stopGenomeCapture, type GenomeCaptureSnapshot } from '@/lib/genome';
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
    installConsoleCapture(); // start collecting client errors immediately
    void ensurePagePicker();

    const host = document.createElement('div');
    host.id = 'linear-grab-root';
    document.body.appendChild(host);

    // Keyboard isolation: shadow retargeting makes e.target the host div (not
    // an input), so host-app "is the user typing?" checks fail and single-
    // letter hotkeys (p, k, …) preventDefault mid-word — swallowing letters.
    // A host-level bubble stopper isn't enough: hotkey libs commonly listen in
    // the CAPTURE phase on document, which fires before the host. Window
    // capture is the one node guaranteed to run before document listeners, so
    // panel keystrokes are killed there and re-dispatched (non-bubbling) at
    // the real target so the panel's own handlers still fire. Default actions
    // (text insertion) come from the original trusted event and are untouched.
    const isolateKeys = (e: Event) => {
      const path = e.composedPath();
      if (!path.includes(host)) return;
      e.stopImmediatePropagation();
      const target = path[0];
      if (e instanceof KeyboardEvent && target && target !== host) {
        target.dispatchEvent(
          new KeyboardEvent(e.type, {
            key: e.key,
            code: e.code,
            location: e.location,
            repeat: e.repeat,
            isComposing: e.isComposing,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            bubbles: false,
            cancelable: false,
          }),
        );
      }
    };
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      window.addEventListener(type, isolateKeys, { capture: true });
    }

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
const PANEL_W_DEFAULT = 380;
const PANEL_W_MIN = 280;
const PANEL_W_MAX = 720;

/** Floating launcher pill (react-grab-style) + docked panel hosting the shared App. */
function PagePanel(props: { defaultOpen: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen);
  const [side, setSide] = createSignal<'left' | 'right'>('right');
  const [pos, setPos] = createSignal({
    x: Math.max(8, window.innerWidth - PILL_W - 24),
    y: Math.max(8, window.innerHeight - PILL_H - 20),
  });
  const [watch, setWatch] = createSignal<AgentWatchSnapshot>({ running: [], review: [] });
  const running = () => watch().running;
  const review = () => watch().review;
  const [minimapOpen, setMinimapOpen] = createSignal(false);
  const [recPhase, setRecPhase] = createSignal(getRecorderSnapshot().phase);
  const [genCap, setGenCap] = createSignal<GenomeCaptureSnapshot>({ active: false, msLeft: 0, total: 0, byTrigger: {} });
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
    x: Math.min(Math.max(8 - (panelWidth() - 80), p.x), window.innerWidth - 80),
    y: Math.min(Math.max(0, p.y), window.innerHeight - 80),
  });

  const [pinned, setPinned] = createSignal(false);
  const [workflow, setWorkflow] = createSignal<'cloud' | 'local'>('cloud');
  const [copiedFlash, setCopiedFlash] = createSignal(false);
  const [panelWidth, setPanelWidth] = createSignal(PANEL_W_DEFAULT);
  const clampWidth = (w: number) =>
    Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, Math.min(w, window.innerWidth - 60)));

  // DevTools-style dock: squeeze the page via a margin on <html> so the app
  // renders BESIDE the panel instead of underneath it. Fixed-position page
  // elements still track the viewport (same caveat real sidebars have).
  createEffect(() => {
    const html = document.documentElement;
    const active = open() && pinned();
    html.style.transition = 'margin 0.2s ease';
    html.style.marginRight = active && side() === 'right' ? `${panelWidth()}px` : '';
    html.style.marginLeft = active && side() === 'left' ? `${panelWidth()}px` : '';
  });
  onCleanup(() => {
    document.documentElement.style.marginRight = '';
    document.documentElement.style.marginLeft = '';
  });

  const togglePin = () => {
    const next = !pinned();
    setPinned(next);
    if (next) setPanelPos(null); // pinned mode is always edge-docked
    void saveSettings({ panelMode: next ? 'pinned' : 'overlay', panelPos: undefined });
  };

  onMount(() => {
    void getSettings().then((s) => {
      if (s.panelSide) setSide(s.panelSide);
      if (s.launcherPos) setPos(clamp(s.launcherPos));
      if (s.panelPos) setPanelPos(clampPanel(s.panelPos));
      if (s.panelWidth) setPanelWidth(clampWidth(s.panelWidth));
      setPinned(s.panelMode === 'pinned');
      setWorkflow(s.workflowMode ?? 'cloud');
    });
    const unsubSettings = subscribeStorage((area) => {
      if (area === 'settings') {
        void getSettings().then((s) => {
          setSide(s.panelSide ?? 'right');
          setPinned(s.panelMode === 'pinned');
          setWorkflow(s.workflowMode ?? 'cloud');
        });
      }
      // Cloud workflow: a grab opens the panel to draft. Local workflow stays
      // out of the way — the context is already on the clipboard.
      if (area === 'grab' && workflow() !== 'local') setOpen(true);
    });

    // Local-mode auto-copy feedback: flash "Copied ✓" in the pill.
    const onCopied = () => {
      setCopiedFlash(true);
      setTimeout(() => setCopiedFlash(false), 1600);
    };
    window.addEventListener(CONTEXT_COPIED_EVENT, onCopied);

    // Picker activated → minimize (like recording) so the page is clear to
    // hover/select; the grab landing reopens the panel in cloud mode.
    // Pinned mode is beside the page — nothing overlaps, stay open.
    const onPickerActivated = () => {
      setMinimapOpen(false);
      if (!pinned()) setOpen(false);
    };
    window.addEventListener(PICKER_ACTIVATED_EVENT, onPickerActivated);
    // Region capture / recording must ALWAYS hand the panel back — even when
    // the capture fails or hangs, this event reopens it.
    const onPickerFinished = () => setOpen(true);
    window.addEventListener('linear-grab:picker-finished', onPickerFinished);

    onCleanup(() => {
      window.removeEventListener(CONTEXT_COPIED_EVENT, onCopied);
      window.removeEventListener(PICKER_ACTIVATED_EVENT, onPickerActivated);
      window.removeEventListener('linear-grab:picker-finished', onPickerFinished);
    });
    const unsubAgents = subscribeRunningAgents(setWatch);

    // Recording choreography: minimize while capturing so the recording shows
    // the APP (not our panel); the pill becomes the stop control; reopen on
    // the Capture tab when the GIF is ready.
    const unsubGenCap = subscribeGenomeCapture(setGenCap);
    onCleanup(unsubGenCap);
    let prevPhase = getRecorderSnapshot().phase;
    const unsubRec = subscribeRecorder((snap) => {
      setRecPhase(snap.phase);
      // Pinned mode = beside the page, nothing overlaps — stay open.
      if (snap.phase === 'recording' && prevPhase !== 'recording' && !pinned()) {
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
      // The click event dispatches synchronously after pointerup — let its
      // guard see the drag, then ALWAYS clear. A stuck-true dragMoved made
      // the pill permanently unclickable (panel could never reopen).
      setTimeout(() => {
        dragMoved = false;
      }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const showMinimapAbove = () => pos().y > 260;

  const openAgent = (id: string) => {
    setMinimapOpen(false);
    openPanelTo('activity', id);
    setOpen(true);
  };

  // DevTools-style width resize from the panel's inner edge.
  const onResizePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = panelWidth();
    const startPos = panelPos();
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const grow = side() === 'right' ? -dx : dx;
      const w = clampWidth(startW + grow);
      setPanelWidth(w);
      // Floating + right-side: the handle is the LEFT edge, keep it under the cursor.
      if (startPos && side() === 'right') {
        setPanelPos(clampPanel({ x: startPos.x + (startW - w), y: startPos.y }));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      void saveSettings({ panelWidth: panelWidth(), ...(panelPos() ? { panelPos: panelPos()! } : {}) });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
      panelPos() ?? { x: side() === 'right' ? window.innerWidth - panelWidth() : 0, y: 0 };
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
            onClick={() => {
              // The WHOLE pill opens the panel (the logo alone was a 13px
              // target — after a capture closed the panel, clicks landed on
              // the agents zone and "nothing happened"). The agents button
              // stops propagation; recording keeps the pill as stop control.
              if (dragMoved || recPhase() === 'recording' || genCap().active) return;
              setMinimapOpen(false);
              setOpen(true);
            }}
            class="bg-surface border-border text-text flex h-9 cursor-grab items-center gap-1 rounded-full border py-1 pr-1 pl-2.5 font-sans shadow-lg active:cursor-grabbing"
          >
            <Show
              when={recPhase() === 'recording' || genCap().active}
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
                  {/* Picking lives in react-grab's own toolbar (the fast,
                      familiar path) — this pill is panel/agents/recording only. */}
                  <span class="bg-border h-4 w-px" aria-hidden />
                  {/* Live agent status — dot pulses while agents run; count is fixed-width. */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); // agents zone toggles the minimap, not the panel
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
                        copiedFlash()
                          ? 'bg-success'
                          : running().length
                            ? 'bg-success animate-pulse'
                            : 'bg-text-faint'
                      }`}
                    />
                    <span
                      class={`min-w-[3.5ch] text-left text-[11px] font-medium tabular-nums ${
                        copiedFlash() ? 'text-success' : 'text-text-dim'
                      }`}
                    >
                      {copiedFlash() ? 'Copied ✓' : `${running().length} run`}
                    </span>
                    {/* Finished agents awaiting YOUR review — amber, attention-worthy. */}
                    <Show when={!copiedFlash() && review().length > 0}>
                      <span aria-hidden class="bg-warn size-2 rounded-full" />
                      <span class="text-warn min-w-[3.5ch] text-left text-[11px] font-medium tabular-nums">
                        {review().length} rev
                      </span>
                    </Show>
                  </button>
                </>
              }
            >
              {/* Recording / genome-capture mode: the panel is minimized so the
                  page is interactive — the pill is the live status + stop control. */}
              <Show
                when={recPhase() === 'recording'}
                fallback={
                  <>
                    <span aria-hidden class="bg-accent size-2 shrink-0 animate-pulse rounded-full" />
                    <span class="text-text min-w-[3ch] text-[11px] font-medium tabular-nums">
                      {Math.ceil(genCap().msLeft / 1000)}s
                    </span>
                    <span
                      class="text-text-dim min-w-[7ch] text-[11px] tabular-nums"
                      title={
                        Object.entries(genCap().byTrigger)
                          .map(([k, v]) => `${v} ${k}`)
                          .join(' · ') || 'hover / open the component to record its states'
                      }
                    >
                      {genCap().total} states
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (dragMoved) return;
                        stopGenomeCapture();
                      }}
                      class="bg-accent hover:bg-accent-hover h-7 cursor-pointer rounded-full px-2.5 text-[11px] font-medium text-white transition-colors"
                    >
                      <span class="inline-block min-w-[4ch] text-center">Stop</span>
                    </button>
                  </>
                }
              >
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
            </Show>
          </div>

          {/* Minimap popover — the running agents at a glance. */}
          <Show when={minimapOpen()}>
            <div
              class={`bg-surface border-border absolute w-72 rounded-lg border p-1.5 font-sans shadow-2xl ${
                showMinimapAbove() ? 'bottom-full mb-2' : 'top-full mt-2'
              } ${pos().x > window.innerWidth - 300 ? 'right-0' : 'left-0'}`}
            >
              <Show when={review().length > 0}>
                <p class="text-warn px-1.5 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-wide uppercase">
                  Needs review
                </p>
                <For each={review()}>
                  {(agent) => <MinimapRow agent={agent} review onOpen={openAgent} />}
                </For>
              </Show>
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
                  {(agent) => <MinimapRow agent={agent} onOpen={openAgent} />}
                </For>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={open()}>
        <div
          class={`bg-bg text-text border-border fixed z-[2147483645] flex max-w-[100vw] flex-col overflow-hidden font-sans text-[13px] antialiased ${
            pinned() ? '' : 'shadow-2xl'
          } ${
            !pinned() && panelPos()
              ? 'rounded-xl border'
              : side() === 'right'
                ? 'top-0 right-0 h-screen border-l'
                : 'top-0 left-0 h-screen border-r'
          }`}
          style={{
            width: `${panelWidth()}px`,
            ...(!pinned() && panelPos()
              ? {
                  left: `${panelPos()!.x}px`,
                  top: `${panelPos()!.y}px`,
                  height: `${Math.min(680, window.innerHeight - 16)}px`,
                }
              : {}),
          }}
        >
          {/* Resize handle on the inner edge — drag to widen/narrow. */}
          <div
            onPointerDown={onResizePointerDown}
            class={`hover:bg-accent/50 active:bg-accent absolute top-0 z-10 h-full w-1 cursor-col-resize transition-colors ${
              side() === 'right' ? 'left-0' : 'right-0'
            }`}
            title="Drag to resize"
          />
          {/* Drag the header to float the panel anywhere; double-click to re-dock.
              Pinned mode is edge-locked, so dragging is disabled there. */}
          <App
            onGrab={() => setOpen(true)}
            onClose={() => setOpen(false)}
            onHeaderPointerDown={pinned() ? undefined : onPanelPointerDown}
            pinned={pinned()}
            onTogglePin={togglePin}
          />
        </div>
      </Show>
    </>
  );
}

/** One agent row in the minimap popover. */
function MinimapRow(props: {
  agent: RunningAgentIssue;
  review?: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      onClick={() => props.onOpen(props.agent.id)}
      class="hover:bg-surface-2 flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors"
    >
      <span class="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          class="size-1.5 shrink-0 rounded-full"
          style={{ background: props.review ? 'var(--color-warn)' : props.agent.stateColor }}
        />
        <span class="font-mono text-text-dim shrink-0 text-[10.5px]">
          {props.agent.identifier}
        </span>
        <span class="text-text truncate text-[11.5px]">{props.agent.title}</span>
      </span>
      <span class="text-text-faint pl-3 text-[10.5px] tabular-nums">
        {props.review ? 'PR ready · needs review' : props.agent.stateName} ·{' '}
        {props.agent.delegateName} · {timeAgoShort(props.agent.updatedAt)}
      </span>
    </button>
  );
}

function timeAgoShort(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
