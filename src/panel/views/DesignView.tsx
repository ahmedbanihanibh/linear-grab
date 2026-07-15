import { createSignal, For, Show } from 'solid-js';
import { Button, EmptyState, ErrorNote, timeAgo } from '../components/ui';
import {
  captureInteractionStates,
  extractGenome,
  genomeToSpec,
  pickElementForExtraction,
  stopGenomeCapture,
  subscribeGenomeCapture,
  type Genome,
  type GenomeCaptureSnapshot,
} from '@/lib/genome';
import { onCleanup } from 'solid-js';
import { PICKER_ACTIVATED_EVENT, PICKER_FINISHED_EVENT } from '@/lib/picker';
import { openPanelTo } from '../nav';
import {
  auditTransitions,
  clearCssSlowdowns,
  cssSlowdownPrompt,
  cssSlowdownReport,
  cssWatchEnabled,
  setCssWatchEnabled,
  subscribeCssSlowdowns,
  subscribeCssWatchEnabled,
  type CssSlowdownFinding,
} from '@/lib/cssSlowdown';
import { formatSlopReport, slopScanPrompt } from '@/lib/slopScan';
import {
  clearSlopFindings,
  scanCurrentPage,
  setSlopLiveEnabled,
  slopLiveEnabled,
  subscribeSlopFindings,
  subscribeSlopLive,
  type PageSlopFinding,
} from '@/lib/slopScanStore';

interface SavedGenome {
  id: number;
  genome: Genome;
}

const STORE_KEY = 'linear-grab:genomes:v1';
const MAX_SAVED = 30;

function loadSaved(): SavedGenome[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as SavedGenome[];
  } catch {
    return [];
  }
}
function persist(list: SavedGenome[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    /* quota — keep in-memory only */
  }
}

/** Live element refs for this page session — lets "Capture states" run on a
    just-extracted genome without re-picking. Reload → re-pick. */
const liveEls = new Map<number, WeakRef<Element>>();

/** Reveal a finding on the page: scroll to it and pulse an outline. */
function flashFinding(f: PageSlopFinding): boolean {
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


export default function DesignView() {
  const [saved, setSaved] = createSignal<SavedGenome[]>(loadSaved());
  const [expanded, setExpanded] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal<'extract' | number | null>(null);
  const [countdown, setCountdown] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [copiedId, setCopiedId] = createSignal<number | null>(null);
  const [cap, setCap] = createSignal<GenomeCaptureSnapshot>({ active: false, msLeft: 0, total: 0, byTrigger: {} });
  onCleanup(subscribeGenomeCapture(setCap));
  const [slowdowns, setSlowdowns] = createSignal<CssSlowdownFinding[]>([]);
  onCleanup(subscribeCssSlowdowns(setSlowdowns));
  const [watchOn, setWatchOn] = createSignal(cssWatchEnabled());
  onCleanup(subscribeCssWatchEnabled(setWatchOn));
  const [auditBusy, setAuditBusy] = createSignal(false);
  const [copiedReport, setCopiedReport] = createSignal(false);
  const runAudit = async () => {
    setAuditBusy(true);
    try {
      await auditTransitions();
    } finally {
      setAuditBusy(false);
    }
  };
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(cssSlowdownReport(slowdowns()));
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };
  const [copiedPrompt, setCopiedPrompt] = createSignal(false);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(cssSlowdownPrompt(slowdowns()));
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };

  // ---- Slop scan (design-contract drift) ----------------------------------
  const [slop, setSlop] = createSignal<PageSlopFinding[]>([]);
  onCleanup(subscribeSlopFindings(setSlop));
  const [slopLive, setSlopLive] = createSignal(slopLiveEnabled());
  onCleanup(subscribeSlopLive(setSlopLive));
  const [slopBusy, setSlopBusy] = createSignal(false);
  const [slopRule, setSlopRule] = createSignal<string | null>(null);
  const [showErrors, setShowErrors] = createSignal(true);
  const [showWarns, setShowWarns] = createSignal(true);
  const [copiedSlopReport, setCopiedSlopReport] = createSignal(false);
  const [copiedSlopPrompt, setCopiedSlopPrompt] = createSignal(false);

  const runScan = () => {
    setError(null);
    setSlopBusy(true);
    try {
      scanCurrentPage();
      setSlopRule(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSlopBusy(false);
    }
  };
  const clearSlop = () => {
    clearSlopFindings();
    setSlopRule(null);
  };
  const slopPages = () => new Set(slop().map((f) => f.page)).size;
  const slopVisible = () =>
    slop().filter((f) => (f.severity === 'error' ? showErrors() : showWarns()));
  /** Findings grouped per rule, errors first, biggest groups first. */
  const slopGroups = () => {
    const map = new Map<string, PageSlopFinding[]>();
    for (const f of slopVisible()) {
      const list = map.get(f.ruleId);
      if (list) list.push(f);
      else map.set(f.ruleId, [f]);
    }
    return [...map.values()].sort(
      (a, b) =>
        Number(b[0].severity === 'error') - Number(a[0].severity === 'error') ||
        b.length - a.length,
    );
  };
  const slopErrorCount = () => slop().filter((f) => f.severity === 'error').length;
  const slopWarnCount = () => slop().length - slopErrorCount();
  const copySlopReport = async () => {
    try {
      await navigator.clipboard.writeText(formatSlopReport(slopVisible()));
      setCopiedSlopReport(true);
      setTimeout(() => setCopiedSlopReport(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };
  const copySlopPrompt = async () => {
    try {
      await navigator.clipboard.writeText(slopScanPrompt(slopVisible()));
      setCopiedSlopPrompt(true);
      setTimeout(() => setCopiedSlopPrompt(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };

  const update = (list: SavedGenome[]) => {
    setSaved(list);
    persist(list);
  };

  const extract = async () => {
    setError(null);
    setBusy('extract');
    window.dispatchEvent(new CustomEvent(PICKER_ACTIVATED_EVENT));
    try {
      const el = await pickElementForExtraction();
      if (!el) return;
      const genome = await extractGenome(el);
      const id = Date.now();
      liveEls.set(id, new WeakRef(el));
      update([{ id, genome }, ...saved()]);
      setExpanded(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      openPanelTo('design'); // panel remounts on reopen — land back on this tab
      window.dispatchEvent(new CustomEvent(PICKER_FINISHED_EVENT));
    }
  };

  const captureStates = async (item: SavedGenome) => {
    setError(null);
    setBusy(item.id);
    window.dispatchEvent(new CustomEvent(PICKER_ACTIVATED_EVENT));
    try {
      let el = liveEls.get(item.id)?.deref() ?? null;
      if (!el || !el.isConnected) {
        // Element from a previous page load — point at it again.
        el = await pickElementForExtraction();
        if (!el) return;
        liveEls.set(item.id, new WeakRef(el));
      }
      const states = await captureInteractionStates(el, 8000, (msLeft) =>
        setCountdown(Math.ceil(msLeft / 1000)),
      );
      if (states.length === 0) {
        setError('No state changes captured — hover/open the component while the 8s window runs.');
      }
      update(
        saved().map((s) =>
          s.id === item.id
            ? { ...s, genome: { ...s.genome, states: [...s.genome.states, ...states] } }
            : s,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setCountdown(null);
      openPanelTo('design');
      window.dispatchEvent(new CustomEvent(PICKER_FINISHED_EVENT));
    }
  };

  const copySpec = async (item: SavedGenome) => {
    try {
      await navigator.clipboard.writeText(genomeToSpec(item.genome));
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };

  const remove = (id: number) => {
    liveEls.delete(id);
    update(saved().filter((s) => s.id !== id));
  };

  const [copiedAll, setCopiedAll] = createSignal(false);
  const copyAllSpecs = async () => {
    try {
      const text = saved()
        .map((s) => genomeToSpec(s.genome))
        .join('\n\n---\n\n');
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1600);
    } catch {
      setError('Clipboard was blocked — click Copy again.');
    }
  };
  const clearAllGenomes = () => {
    liveEls.clear();
    update([]);
    setExpanded(null);
  };

  return (
    <div class="flex h-full flex-col gap-3 overflow-y-auto pt-3 pb-4 pr-3 pl-2">
      <div class="flex items-center justify-between gap-2 px-1">
        <div class="min-w-0">
          <p class="text-text text-[12.5px] font-semibold">Design genomes</p>
          <p class="text-text-faint text-[10.5px] leading-snug">
            Point at a component → get its structure, tokens and interaction
            states as a spec you can hand to an agent.
          </p>
        </div>
        <Button
          variant="primary"
          class="h-7 shrink-0 px-2.5 text-[11.5px]"
          loading={busy() === 'extract'}
          onClick={() => void extract()}
        >
          <span class="inline-block min-w-[7ch] text-center">Extract</span>
        </Button>
      </div>

      <Show when={error()}>
        <ErrorNote message={error()!} />
      </Show>

      <Show
        when={saved().length > 0}
        fallback={
          <EmptyState title="No genomes yet">
            Click Extract and pick any component on the page — a dropdown, a
            card, a sidebar row. Then "Capture states" while you hover/open it
            to record the styles that only exist during interaction.
          </EmptyState>
        }
      >
        {/* Thread rail — same anatomy as the issue activity thread. */}
        <div class="relative flex flex-col gap-2 pl-4">
          <div class="bg-border absolute top-1 bottom-1 left-[5px] w-px" aria-hidden />
          <For each={saved()}>
            {(item) => {
              const open = () => expanded() === item.id;
              return (
                <div class="relative">
                  <span
                    class="border-border bg-surface absolute top-3 -left-[13.5px] size-[9px] rounded-full border"
                    classList={{ 'bg-accent border-accent': open() }}
                    aria-hidden
                  />
                  <div class="bg-surface border-border flex flex-col rounded-lg border">
                    <button
                      class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
                      onClick={() => setExpanded(open() ? null : item.id)}
                    >
                      <span class="text-accent min-w-0 truncate font-mono text-[12px]">
                        {item.genome.title}
                      </span>
                      <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                        {item.genome.nodes.length} roles
                        {item.genome.states.length ? ` · ${item.genome.states.length} states` : ''}
                        {' · '}
                        {timeAgo(item.genome.extractedAt)}
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
                      <div class="border-border flex flex-col gap-2 border-t px-2.5 py-2">
                        <p class="text-text-faint truncate text-[10px]">{item.genome.pageUrl}</p>
                        <div class="flex max-h-64 flex-col gap-2 overflow-y-auto pr-2">
                          <For each={item.genome.nodes}>
                            {(n) => (
                              <div class="flex flex-col gap-0.5">
                                <p class="text-text text-[11px] font-medium">
                                  {n.label}
                                  <Show when={n.count > 1}>
                                    <span class="text-text-faint"> ×{n.count}</span>
                                  </Show>
                                </p>
                                <For each={Object.entries(n.styles)}>
                                  {([k, v]) => (
                                    <p class="text-text-dim font-mono text-[10px] leading-snug break-all">
                                      {k}: {v}
                                      <Show when={n.tokens[k]}>
                                        <span class="text-accent"> ← var({n.tokens[k]})</span>
                                      </Show>
                                    </p>
                                  )}
                                </For>
                              </div>
                            )}
                          </For>
                          <Show when={item.genome.states.length > 0}>
                            <p class="text-text mt-1 text-[11px] font-semibold">Interaction states</p>
                            <For each={item.genome.states}>
                              {(s) => (
                                <div class="flex flex-col gap-0.5">
                                  <p class="text-warn text-[10.5px] font-medium">
                                    {s.label} — {s.trigger}
                                  </p>
                                  <For each={Object.entries(s.changed)}>
                                    {([k, c]) => (
                                      <p class="text-text-dim font-mono text-[10px] leading-snug break-all">
                                        {k}: {c.from} → {c.to}
                                      </p>
                                    )}
                                  </For>
                                </div>
                              )}
                            </For>
                          </Show>
                        </div>
                        <div class="flex items-center gap-1">
                          <Show
                            when={busy() === item.id && cap().active}
                            fallback={
                              <Button
                                class="size-7 px-0"
                                variant="ghost"
                                loading={busy() === item.id}
                                title="Capture states — records hover/focus/open styles for 8s while you interact; the pill shows the timer and Stop"
                                aria-label="Capture interaction states"
                                onClick={() => void captureStates(item)}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                                  <circle cx="8" cy="8" r="6" />
                                  <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
                                </svg>
                              </Button>
                            }
                          >
                            <Button
                              class="text-danger size-7 px-0"
                              variant="ghost"
                              title={`Stop recording — ${Math.ceil(cap().msLeft / 1000)}s left · ${cap().total} captured`}
                              aria-label="Stop recording states"
                              onClick={() => stopGenomeCapture()}
                            >
                              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
                              </svg>
                            </Button>
                            <span class="text-warn text-[10.5px] font-medium tabular-nums">
                              {Math.ceil(cap().msLeft / 1000)}s · {cap().total} states
                            </span>
                          </Show>
                          <Button
                            class="size-7 px-0"
                            variant="ghost"
                            title={copiedId() === item.id ? 'Copied!' : 'Copy spec — markdown for an agent or issue'}
                            aria-label="Copy genome spec"
                            onClick={() => void copySpec(item)}
                          >
                            <Show
                              when={copiedId() === item.id}
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
                            class="text-danger ml-auto size-7 px-0"
                            variant="ghost"
                            title="Delete this genome"
                            aria-label="Delete genome"
                            onClick={() => remove(item.id)}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                              <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <div class="flex items-center justify-end gap-1 px-1">
          <Button
            class="size-7 px-0"
            variant="ghost"
            title={copiedAll() ? 'Copied!' : 'Copy all genomes as one markdown document'}
            aria-label="Copy all genomes"
            onClick={() => void copyAllSpecs()}
          >
            <Show
              when={copiedAll()}
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
            title="Delete all saved genomes"
            aria-label="Delete all genomes"
            onClick={clearAllGenomes}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
        </div>
      </Show>

      {/* ---- CSS slowdowns — the lag react-scan can't see ------------------ */}
      <div class="border-border mt-1 flex flex-col gap-2 border-t pt-3">
        <div class="flex items-center justify-between gap-2 px-1">
          <div class="min-w-0">
            <p class="text-text text-[12.5px] font-semibold">CSS slowdowns</p>
            <p class="text-text-faint text-[10.5px] leading-snug">
              Transitions/delays over the 100ms house cap (§42) on interactive
              elements — feedback that animates instead of being instant. Live
              hits appear as you use the app; Audit sweeps the whole page.
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              class="size-7 px-0"
              variant="ghost"
              title={
                watchOn()
                  ? 'Live capture ON — recording transitions fired by your input. Click to pause.'
                  : 'Live capture PAUSED — click to resume recording input-triggered transitions.'
              }
              aria-label={watchOn() ? 'Pause live capture' : 'Start live capture'}
              onClick={() => setCssWatchEnabled(!watchOn())}
            >
              <Show
                when={watchOn()}
                fallback={
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <path d="M4.5 2.5v11l9-5.5z" />
                  </svg>
                }
              >
                <span class="relative inline-flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <rect x="3.5" y="3" width="3.2" height="10" rx="1" />
                    <rect x="9.3" y="3" width="3.2" height="10" rx="1" />
                  </svg>
                  <span class="bg-success absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full" aria-hidden />
                </span>
              </Show>
            </Button>
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-[11.5px]"
              loading={auditBusy()}
              onClick={() => void runAudit()}
            >
              <span class="inline-block min-w-[5ch] text-center">Audit</span>
            </Button>
          </div>
        </div>
        <Show
          when={slowdowns().length > 0}
          fallback={
            <p class="text-text-faint px-1 text-[10.5px]">
              Nothing caught yet — interact with the app, or run Audit.
            </p>
          }
        >
          <div class="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-2">
            <For each={slowdowns()}>
              {(f) => (
                <div class="bg-surface border-border flex flex-col gap-0.5 rounded-lg border p-2">
                  <div class="flex items-center gap-2">
                    <span class="text-warn shrink-0 text-[10px] font-semibold tracking-wide uppercase">
                      {f.mode === 'live' ? 'live' : 'audit'}
                    </span>
                    <span class="text-accent min-w-0 truncate font-mono text-[11.5px]">
                      {f.component ?? f.element}
                      <Show when={f.count > 1}> ×{f.count}</Show>
                    </span>
                    <span class="text-text ml-auto shrink-0 text-[11px] font-medium tabular-nums">
                      {f.durationMs}ms{f.delayMs ? ` +${f.delayMs}` : ''}
                    </span>
                  </div>
                  <Show when={f.source}>
                    <span class="text-text-dim font-mono text-[10px] break-all">{f.source}</span>
                  </Show>
                  <span class="text-text-dim text-[10px] leading-snug">
                    {f.properties.join(', ')}
                    <Show when={f.sinceInputMs != null}> — fired {f.sinceInputMs}ms after input</Show>
                  </span>
                  <Show when={f.jankProps?.length}>
                    <span class="text-danger text-[10px] leading-snug">
                      ⚠ layout/paint transition: {f.jankProps!.join(', ')}
                    </span>
                  </Show>
                  <Show when={f.easing}>
                    <span class="text-danger text-[10px] leading-snug">⚠ ease-in easing: {f.easing}</span>
                  </Show>
                  <span class="text-text-faint text-[10px] leading-snug">{f.suggestion}</span>
                </div>
              )}
            </For>
          </div>
          <div class="flex items-center gap-1 px-1">
            <Button
              class="size-7 px-0"
              variant="primary"
              title={copiedPrompt() ? 'Copied!' : 'Copy AI prompt — report + fix rules, ready to paste into a Claude Code session'}
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
                <span class="text-[12px] leading-none">✓</span>
              </Show>
            </Button>
            <Button
              class="size-7 px-0"
              variant="ghost"
              title={copiedReport() ? 'Copied!' : 'Copy report — plain markdown findings'}
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
              class="text-danger ml-auto size-7 px-0"
              variant="ghost"
              title="Clear all findings (live + audit)"
              aria-label="Clear all findings"
              onClick={clearCssSlowdowns}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </Button>
          </div>
        </Show>
      </div>

      {/* ---- Slop scan — design-contract drift ---------------------------- */}
      <div class="border-border mt-1 flex flex-col gap-2 border-t pt-3">
        <div class="flex items-center justify-between gap-2 px-1">
          <div class="min-w-0">
            <p class="text-text text-[12.5px] font-semibold">
              Slop scan
              <Show when={slopPages() > 1}>
                <span class="text-text-faint font-normal tabular-nums"> · {slopPages()} pages</span>
              </Show>
            </p>
            <p class="text-text-faint text-[10.5px] leading-snug">
              Design-contract drift — Linear-primitives rules checked against
              the live DOM. Results accumulate per page as you navigate;
              re-scanning a page overwrites only that page's findings.
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              class="size-7 px-0"
              variant="ghost"
              title={
                slopLive()
                  ? 'Live scan ON — re-scans automatically ~1s after each route change. Click to pause.'
                  : 'Live scan PAUSED — click to auto-scan every page you navigate to.'
              }
              aria-label={slopLive() ? 'Pause live scan' : 'Start live scan'}
              onClick={() => setSlopLiveEnabled(!slopLive())}
            >
              <Show
                when={slopLive()}
                fallback={
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <path d="M4.5 2.5v11l9-5.5z" />
                  </svg>
                }
              >
                <span class="relative inline-flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <rect x="3.5" y="3" width="3.2" height="10" rx="1" />
                    <rect x="9.3" y="3" width="3.2" height="10" rx="1" />
                  </svg>
                  <span class="bg-success absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full" aria-hidden />
                </span>
              </Show>
            </Button>
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-[11.5px]"
              loading={slopBusy()}
              title="Scan this page — cumulative: keeps other pages' findings, replaces this page's"
              onClick={runScan}
            >
              <span class="inline-block min-w-[4ch] text-center">Scan</span>
            </Button>
          </div>
        </div>
        <Show
          when={slop().length > 0}
          fallback={
            <p class="text-text-faint px-1 text-[10.5px]">
              No scan yet — click Scan to audit this page against the contract.
            </p>
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
              {slopErrorCount()} errors
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
              {slopWarnCount()} warns
            </button>
          </div>
          <div class="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-2">
            <For each={slopGroups()}>
              {(group) => {
                const head = group[0];
                const open = () => slopRule() === head.ruleId;
                return (
                  <div class="bg-surface border-border flex flex-col rounded-lg border">
                    <button
                      class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
                      onClick={() => setSlopRule(open() ? null : head.ruleId)}
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
                        {head.ruleId}
                      </span>
                      <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                        ×{group.length}
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
                        <p class="text-text-dim text-[10px] leading-snug">{head.description}</p>
                        <For each={group}>
                          {(f) => (
                            <button
                              class="hover:bg-surface-2 flex w-full cursor-pointer flex-col gap-0.5 rounded px-1 py-0.5 text-left"
                              title="Reveal on the page"
                              onClick={() => {
                                if (flashFinding(f)) return;
                                setError(
                                  f.page !== location.pathname
                                    ? `This finding is on ${f.page} — navigate there to reveal it.`
                                    : 'Element is gone — run Scan again.',
                                );
                              }}
                            >
                              <span class="text-text min-w-0 truncate font-mono text-[10.5px]">
                                <Show when={slopPages() > 1}>
                                  <span class="text-accent">{f.page} </span>
                                </Show>
                                {f.selector}
                              </span>
                              <span class="text-text-faint font-mono text-[10px] leading-snug break-all">
                                {f.evidence}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="flex items-center gap-1 px-1">
            <Button
              class="size-7 px-0"
              variant="primary"
              title={copiedSlopPrompt() ? 'Copied!' : 'Copy AI prompt — findings + contract fix rules, ready for a Claude Code session'}
              aria-label="Copy AI fix prompt"
              onClick={() => void copySlopPrompt()}
            >
              <Show
                when={copiedSlopPrompt()}
                fallback={
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                    <path d="M8 1.5 9.6 6l4.4 1.6L9.6 9.2 8 13.7 6.4 9.2 2 7.6 6.4 6Z" />
                    <path d="M13 11.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6Z" />
                  </svg>
                }
              >
                <span class="text-[12px] leading-none">✓</span>
              </Show>
            </Button>
            <Button
              class="size-7 px-0"
              variant="ghost"
              title={copiedSlopReport() ? 'Copied!' : 'Copy report — findings grouped by rule, markdown'}
              aria-label="Copy slop report"
              onClick={() => void copySlopReport()}
            >
              <Show
                when={copiedSlopReport()}
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
              class="text-danger ml-auto size-7 px-0"
              variant="ghost"
              title="Clear scan results"
              aria-label="Clear scan results"
              onClick={clearSlop}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </Button>
          </div>
        </Show>
      </div>
    </div>
  );
}
