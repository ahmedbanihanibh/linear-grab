import { createSignal, For, Show } from 'solid-js';
import { Button, EmptyState, ErrorNote, timeAgo } from '../components/ui';
import {
  captureInteractionStates,
  extractGenome,
  genomeToSpec,
  pickElementForExtraction,
  type Genome,
} from '@/lib/genome';
import { PICKER_ACTIVATED_EVENT, PICKER_FINISHED_EVENT } from '@/lib/picker';

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

      <Show when={countdown() !== null}>
        <p class="text-warn px-1 text-[11px] font-medium">
          Recording interactions — hover / open the component now…{' '}
          <span class="tabular-nums">{countdown()}s</span>
        </p>
      </Show>
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
                        <div class="flex items-center gap-1.5">
                          <Button
                            class="h-6 px-2 text-[11px]"
                            variant="ghost"
                            loading={busy() === item.id}
                            title="Record hover/focus/open styles for 8 seconds while you interact"
                            onClick={() => void captureStates(item)}
                          >
                            Capture states
                          </Button>
                          <Button
                            class="h-6 px-2 text-[11px]"
                            variant="ghost"
                            title="Copy the genome as a markdown spec — paste to an agent or issue"
                            onClick={() => void copySpec(item)}
                          >
                            <span class="inline-block min-w-[8ch] text-center">
                              {copiedId() === item.id ? 'Copied ✓' : 'Copy spec'}
                            </span>
                          </Button>
                          <Button
                            class="text-danger ml-auto h-6 px-2 text-[11px]"
                            variant="ghost"
                            onClick={() => remove(item.id)}
                          >
                            Delete
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
    </div>
  );
}
