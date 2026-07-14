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
  cssSlowdownReport,
  subscribeCssSlowdowns,
  type CssSlowdownFinding,
} from '@/lib/cssSlowdown';

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
      </Show>

      {/* ---- CSS slowdowns — the lag react-scan can't see ------------------ */}
      <div class="border-border mt-1 flex flex-col gap-2 border-t pt-3">
        <div class="flex items-center justify-between gap-2 px-1">
          <div class="min-w-0">
            <p class="text-text text-[12.5px] font-semibold">CSS slowdowns</p>
            <p class="text-text-faint text-[10.5px] leading-snug">
              Transitions/delays ≥50ms on interactive elements — feedback that
              animates instead of being instant. Live hits appear as you use
              the app; Audit sweeps the whole page.
            </p>
          </div>
          <Button
            variant="ghost"
            class="h-7 shrink-0 px-2.5 text-[11.5px]"
            loading={auditBusy()}
            onClick={() => void runAudit()}
          >
            <span class="inline-block min-w-[5ch] text-center">Audit</span>
          </Button>
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
                  <span class="text-text-faint text-[10px] leading-snug">{f.suggestion}</span>
                </div>
              )}
            </For>
          </div>
          <div class="flex items-center gap-1.5 px-1">
            <Button class="h-6 px-2 text-[11px]" variant="ghost" onClick={() => void copyReport()}>
              <span class="inline-block min-w-[10ch] text-center">
                {copiedReport() ? 'Copied ✓' : 'Copy report'}
              </span>
            </Button>
            <Button class="h-6 px-2 text-[11px]" variant="ghost" onClick={clearCssSlowdowns}>
              Clear audit
            </Button>
          </div>
        </Show>
      </div>
    </div>
  );
}
