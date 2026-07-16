import { createSignal, onCleanup, For, Show } from 'solid-js';
import { Button, EmptyState, ErrorNote } from '../components/ui';
import { formatRenderReport, renderScanPrompt } from '@/lib/renderScan';
import {
  clearRenderFindings,
  getRenderRulebook,
  peekRenderRulebook,
  runSnapshotScan,
  setRenderLiveEnabled,
  startRenderRecording,
  stopRenderRecording,
  subscribeRenderFindings,
  subscribeRenderLive,
  subscribeRenderRecording,
  type PageRenderFinding,
} from '@/lib/renderScanStore';
import type { RenderRulebook } from '@/lib/renderRulebook';

/** Reveal a finding on the page: scroll to it and pulse an outline. Copied from
    DesignView's flashFinding — same amber outline, same 1.4s hold. */
function flashFinding(f: PageRenderFinding): boolean {
  const el = f.el?.deref();
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = '2px solid #e5a13a';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, 1400);
  return true;
}

/** m:ss elapsed since a start timestamp (recording readout). */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Strip the `prop:` prefix from a change token for display (`onClick(fn)`). */
function changeLabel(ch: string): string {
  return ch.replace(/^prop:/, '');
}

export default function RendersView() {
  const [findings, setFindings] = createSignal<PageRenderFinding[]>([]);
  onCleanup(subscribeRenderFindings(setFindings));

  const [recording, setRecording] = createSignal(false);
  const [recStart, setRecStart] = createSignal<number | null>(null);

  // Elapsed timer — ticks every 500ms while recording, so the m:ss readout
  // stays live. Owned by the recording SUBSCRIPTION (not the button handler):
  // recording is module-level state that survives a panel close/reopen, so the
  // timer must restart whenever a mount observes an already-live recording.
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  onCleanup(stopTimer);
  onCleanup(
    subscribeRenderRecording((on, startedAt) => {
      setRecording(on);
      setRecStart(startedAt);
      if (on) {
        setNow(Date.now());
        if (!timer) timer = setInterval(() => setNow(Date.now()), 500);
      } else {
        stopTimer();
      }
    }),
  );

  const [live, setLive] = createSignal(false);
  onCleanup(subscribeRenderLive(setLive));

  // The parsed rulebook, for group-header slugs. Prefetch on mount (fills the
  // module cache); peek keeps it in sync after a scan awaited it.
  const [rulebook, setRulebook] = createSignal<RenderRulebook | null>(peekRenderRulebook());
  void getRenderRulebook().then(setRulebook);

  const [error, setError] = createSignal<string | null>(null);
  const [rule, setRule] = createSignal<string | null>(null);
  const [showErrors, setShowErrors] = createSignal(true);
  const [showWarns, setShowWarns] = createSignal(true);
  const [snapBusy, setSnapBusy] = createSignal(false);
  const [copiedReport, setCopiedReport] = createSignal(false);
  const [copiedPrompt, setCopiedPrompt] = createSignal(false);

  const toggleRecord = async () => {
    setError(null);
    if (recording()) {
      try {
        const found = await stopRenderRecording();
        setRulebook(peekRenderRulebook());
        setRule(null);
        if (found.length === 0)
          setError('No re-render anti-patterns caught — interact more (scroll, open menus, type) between record and stop.');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } else {
      startRenderRecording(); // the recording subscription starts the timer
    }
  };

  const runSnapshot = () => {
    setError(null);
    setSnapBusy(true);
    try {
      runSnapshotScan();
      setRule(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSnapBusy(false);
    }
  };

  const clear = () => {
    clearRenderFindings();
    setRule(null);
  };

  const pages = () => new Set(findings().map((f) => f.page)).size;
  const visible = () =>
    findings().filter((f) => (f.severity === 'error' ? showErrors() : showWarns()));
  const errorCount = () =>
    findings().filter((f) => f.severity === 'error').reduce((n, f) => n + (f.count ?? 1), 0);
  const warnCount = () =>
    findings().reduce((n, f) => n + (f.count ?? 1), 0) - errorCount();

  /** Findings grouped by ruleId (null → "budget"), errors first, biggest first. */
  const groups = () => {
    const map = new Map<string, PageRenderFinding[]>();
    for (const f of visible()) {
      const key = f.ruleId ?? 'budget';
      const list = map.get(key);
      if (list) list.push(f);
      else map.set(key, [f]);
    }
    return [...map.entries()].sort(
      (a, b) =>
        Number(b[1][0].severity === 'error') - Number(a[1][0].severity === 'error') ||
        b[1].length - a[1].length,
    );
  };

  /** `R5 · identity-churn` when the rulebook slug is known, else the bare id. */
  const groupLabel = (key: string): string => {
    const slug = key === 'budget' ? null : rulebook()?.rules[key]?.slug ?? null;
    return slug ? `${key} · ${slug}` : key;
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(formatRenderReport(visible()));
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(renderScanPrompt(visible(), await getRenderRulebook()));
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };

  return (
    <div class="flex h-full flex-col gap-3 overflow-y-auto pt-3 pb-4 pr-3 pl-2">
      <div class="flex flex-col gap-1 px-1">
        <div class="flex items-center justify-between gap-2">
          <p class="text-text min-w-0 truncate text-[12.5px] font-semibold">
            Renders
            <Show when={pages() > 1}>
              <span class="text-text-faint font-normal tabular-nums"> · {pages()} pages</span>
            </Show>
          </p>
          <div class="flex shrink-0 items-center gap-1">
          {/* Pulsing dot + m:ss elapsed, left of the toggle, only while recording. */}
          <Show when={recording()}>
            <span class="bg-danger size-1.5 shrink-0 animate-pulse rounded-full" aria-hidden />
            <span class="text-danger inline-block min-w-[4ch] text-right text-[10.5px] font-medium tabular-nums">
              {elapsed(now() - (recStart() ?? now()))}
            </span>
          </Show>
          <Button
            class="size-7 px-0"
            variant={recording() ? 'danger' : 'ghost'}
            disabled={live()}
            title={live() ? 'Live scan owns the recorder — pause it first' : recording() ? 'Stop & analyze' : 'Record renders'}
            aria-label={recording() ? 'Stop and analyze' : 'Record renders'}
            onClick={() => void toggleRecord()}
          >
            <Show
              when={recording()}
              fallback={
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden>
                  <circle cx="8" cy="8" r="6" />
                  <circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" />
                </svg>
              }
            >
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
              </svg>
            </Show>
          </Button>
          <Button
            class="relative size-7 px-0"
            variant="ghost"
            disabled={recording()}
            title={live() ? 'Pause live render scan' : 'Live render scan — findings update as you browse'}
            aria-label="Toggle live render scan"
            onClick={() => setRenderLiveEnabled(!live())}
          >
            <Show
              when={live()}
              fallback={
                <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                  <path d="M5 3.3v9.4a.5.5 0 0 0 .77.42l7.1-4.7a.5.5 0 0 0 0-.84l-7.1-4.7A.5.5 0 0 0 5 3.3Z" fill="currentColor" />
                </svg>
              }
            >
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                <rect x="4" y="3.5" width="3" height="9" rx="1" fill="currentColor" />
                <rect x="9" y="3.5" width="3" height="9" rx="1" fill="currentColor" />
              </svg>
            </Show>
            <Show when={live()}>
              <span class="bg-success absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full" aria-hidden />
            </Show>
          </Button>
          <Button
            class="size-7 px-0"
            variant="ghost"
            loading={snapBusy()}
            title="Snapshot scan (passive DOM pass)"
            aria-label="Snapshot scan"
            onClick={runSnapshot}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
              <path d="M5.5 3 6.5 1.5h3L10.5 3h2A1.5 1.5 0 0 1 14 4.5v7A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3h2Z" />
              <circle cx="8" cy="7.75" r="2.25" />
            </svg>
          </Button>
          <Button
            class="size-7 px-0"
            variant="ghost"
            title={copiedPrompt() ? 'Copied!' : 'Copy AI fix prompt'}
            aria-label="Copy AI fix prompt"
            onClick={() => void copyPrompt()}
          >
            <Show
              when={copiedPrompt()}
              fallback={
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                  <path d="M8 1.5 9.6 6l4.4 1.6L9.6 9.2 8 13.7 6.4 9.2 2 7.6 6.4 6Z" />
                  <path d="M13 11.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6Z" />
                </svg>
              }
            >
              <span class="text-success text-[12px] leading-none">✓</span>
            </Show>
          </Button>
          <Button
            class="size-7 px-0"
            variant="ghost"
            title={copiedReport() ? 'Copied!' : 'Copy report'}
            aria-label="Copy report"
            onClick={() => void copyReport()}
          >
            <Show
              when={copiedReport()}
              fallback={
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden>
                  <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
                  <path d="M10.5 5.5v-2a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" />
                </svg>
              }
            >
              <span class="text-success text-[12px] leading-none">✓</span>
            </Show>
          </Button>
          <Button
            class="text-danger size-7 px-0"
            variant="ghost"
            title="Clear findings"
            aria-label="Clear findings"
            onClick={clear}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
          </div>
        </div>
        <p class="text-text-faint text-[10.5px] leading-snug">
          Commits graded against React-rerender-primitives.md — record then
          interact, go live, or snapshot the DOM. Accumulates per page.
        </p>
      </div>

      <Show when={error()}>
        <ErrorNote message={error()!} />
      </Show>

      <Show when={recording()}>
        <p class="text-text-faint px-1 text-[10.5px] leading-snug">
          Recording commits… interact with the page.
        </p>
      </Show>
      <Show when={live() && !recording()}>
        <p class="text-text-faint px-1 text-[10.5px] leading-snug">
          Live render scan — findings update as you interact and navigate.
        </p>
      </Show>

      <Show
        when={findings().length > 0}
        fallback={
          <Show when={!recording() && !live()}>
            <EmptyState title="No renders scanned yet">
              Press record, then interact — scroll, open menus, navigate, type —
              and stop to analyze. Or go live and watch findings stream in as
              you browse. Snapshot grades the current DOM without recording.
            </EmptyState>
          </Show>
        }
      >
        <div class="flex items-center gap-1 px-1">
          <button
            class="border-border cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums"
            classList={{
              'text-danger bg-danger/10 border-danger/40': showErrors(),
              'text-text-faint': !showErrors(),
            }}
            aria-pressed={showErrors()}
            onClick={() => setShowErrors(!showErrors())}
          >
            {errorCount()} errors
          </button>
          <button
            class="border-border cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums"
            classList={{
              'text-warn bg-warn/10 border-warn/40': showWarns(),
              'text-text-faint': !showWarns(),
            }}
            aria-pressed={showWarns()}
            onClick={() => setShowWarns(!showWarns())}
          >
            {warnCount()} warns
          </button>
        </div>

        <div class="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto pr-3 pl-2">
          <For each={groups()}>
            {([key, group]) => {
              const head = group[0];
              const open = () => rule() === key;
              return (
                <div class="bg-surface border-border flex flex-col rounded-lg border">
                  <button
                    class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => setRule(open() ? null : key)}
                  >
                    <span
                      class="size-1.5 shrink-0 rounded-full"
                      classList={{
                        'bg-danger': head.severity === 'error',
                        'bg-warn': head.severity === 'warn',
                      }}
                      aria-hidden
                    />
                    <span class="text-accent min-w-0 truncate font-mono text-[11.5px]">
                      {groupLabel(key)}
                    </span>
                    <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                      ×{group.reduce((n, x) => n + (x.count ?? 1), 0)}
                    </span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      class="text-text-faint shrink-0 transition-transform"
                      classList={{ 'rotate-180': open() }}
                      aria-hidden
                    >
                      <path d="m4 6 4 4 4-4" />
                    </svg>
                  </button>
                  <Show when={open()}>
                    <div class="border-border flex flex-col gap-1 border-t px-2 py-1.5">
                      <For each={group}>
                        {(f) => {
                          const alive = () => f.el?.deref() != null;
                          return (
                            <div
                              class="flex flex-col gap-0.5 rounded px-1 py-0.5 text-left"
                              classList={{
                                'hover:bg-surface-2 cursor-pointer': alive(),
                              }}
                              title={alive() ? 'Reveal on the page' : undefined}
                              onClick={() => {
                                if (!alive()) return;
                                if (flashFinding(f)) return;
                                setError(
                                  f.page !== location.pathname
                                    ? `This finding is on ${f.page} — navigate there to reveal it.`
                                    : 'Element is gone — record or snapshot again.',
                                );
                              }}
                            >
                              <span class="text-text-dim text-[10.5px] leading-snug">
                                <Show when={pages() > 1}>
                                  <span class="text-accent font-mono">{f.page} </span>
                                </Show>
                                {f.description}
                                <Show when={(f.count ?? 1) > 1}>
                                  <span class="text-text-faint tabular-nums"> ×{f.count}</span>
                                </Show>
                              </span>
                              <Show when={f.changes.length > 0}>
                                <span class="flex flex-wrap gap-1">
                                  <For each={f.changes}>
                                    {(ch) => (
                                      <span class="bg-surface-2 text-text-dim rounded px-1 font-mono text-[9.5px] leading-relaxed">
                                        {changeLabel(ch)}
                                      </span>
                                    )}
                                  </For>
                                </span>
                              </Show>
                              <span class="text-text-faint text-[10px] leading-snug tabular-nums">
                                {f.evidence}
                                <Show when={f.component || f.source}>
                                  <span class="text-text-dim font-mono">
                                    {' · '}
                                    {[f.component, f.source].filter(Boolean).join(' @ ')}
                                  </span>
                                </Show>
                              </span>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
