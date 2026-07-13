import {
  createSignal,
  createMemo,
  createEffect,
  Show,
  For,
  Index,
  onCleanup,
} from 'solid-js';
import { createQuery, createMutation, useQueryClient } from '@tanstack/solid-query';
import type { AiProvider, AiTier, GrabbedElement } from '@/lib/types';
import { getSettings, clearLastGrab, getLastGrab } from '@/lib/storage';
import { startDraftStream } from '@/lib/draftClient';
import { activatePicker } from '@/lib/picker';
import {
  getRecorderSnapshot,
  subscribeRecorder,
  startRecording,
  stopRecording,
  discardRecording,
  markRecordingUploaded,
} from '@/lib/recorder';
import { fetchTeams, createIssue } from '@/lib/linear/api';
import { uploadFileToLinear } from '@/lib/linear/upload';
import { resolveProvider, MODELS } from '@/lib/ai/providers';
import { composeIssueBody } from '@/lib/ai/prompt';
import {
  Button,
  Input,
  Textarea,
  Select,
  Field,
  Section,
  Badge,
  EmptyState,
  ErrorNote,
  Spinner,
  PRIORITY_LABELS,
} from '../components/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FellBackInfo {
  provider: AiProvider;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DraftView(props: { onCreated: () => void }) {
  const queryClient = useQueryClient();

  // ---- Queries ---------------------------------------------------------------

  const grabQuery = createQuery(() => ({
    queryKey: ['grab'],
    queryFn: getLastGrab,
  }));

  const settingsQuery = createQuery(() => ({
    queryKey: ['settings'],
    queryFn: getSettings,
  }));

  // ---- Derived state --------------------------------------------------------

  const settings = createMemo(() => settingsQuery.data ?? {});
  const grab = createMemo<GrabbedElement | null>(
    () => grabQuery.data?.[0] ?? null,
  );

  const linearConnected = createMemo(
    () => !!(settings().linearApiKey || settings().linearAccessToken),
  );

  const provider = createMemo(() => resolveProvider(settings()));

  // ---- Form signals ---------------------------------------------------------

  const [title, setTitle] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [reproSteps, setReproSteps] = createSignal<string[]>([]);
  const [expected, setExpected] = createSignal('');
  const [actual, setActual] = createSignal('');
  const [priority, setPriority] = createSignal(0);
  const [teamId, setTeamId] = createSignal(settings().defaultTeamId ?? '');
  const [repo, setRepo] = createSignal(settings().defaultRepo ?? '');
  const [delegateOn, setDelegateOn] = createSignal(!!settings().cursorAgentId);
  const [note, setNote] = createSignal('');
  const [tier, setTier] = createSignal<AiTier>('fast');

  // When settings load, initialise defaults (runs exactly once on first real data).
  let defaultsApplied = false;
  createEffect(() => {
    const s = settingsQuery.data;
    if (defaultsApplied || !s) return;
    defaultsApplied = true;
    setTeamId(s.defaultTeamId ?? '');
    setRepo(s.defaultRepo ?? '');
    setDelegateOn(!!s.cursorAgentId);
  });

  // ---- Teams query ----------------------------------------------------------

  const teamsQuery = createQuery(() => ({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: linearConnected(),
  }));

  const selectedTeamName = createMemo(() => {
    const teams = teamsQuery.data ?? [];
    return teams.find((t) => t.id === teamId())?.name;
  });

  // ---- AI streaming state ---------------------------------------------------

  const [drafting, setDrafting] = createSignal(false);
  const [draftError, setDraftError] = createSignal<string | null>(null);
  const [fellBack, setFellBack] = createSignal<FellBackInfo | null>(null);

  let cancelDraft: (() => void) | null = null;

  const stopDraft = () => {
    cancelDraft?.();
    cancelDraft = null;
  };

  onCleanup(stopDraft);

  const applyDraft = (d: Partial<{
    title: string;
    description: string;
    reproSteps: string[];
    expected: string;
    actual: string;
    priority: number;
  }>) => {
    if (d.title !== undefined) setTitle(d.title);
    if (d.description !== undefined) setDescription(d.description);
    if (d.reproSteps !== undefined) setReproSteps(d.reproSteps);
    if (d.expected !== undefined) setExpected(d.expected);
    if (d.actual !== undefined) setActual(d.actual);
    if (d.priority !== undefined) setPriority(d.priority);
  };

  const startDraft = () => {
    if (!provider()) return;
    setDrafting(true);
    setDraftError(null);
    setFellBack(null);
    stopDraft();

    // Host-agnostic: extension routes through the worker port; page mode
    // (Safari/Firefox/any browser) streams in-process.
    cancelDraft = startDraftStream(
      {
        note: note(),
        grabbed: grab() ?? null,
        teamName: selectedTeamName(),
        tier: tier(),
      },
      {
        onPartial: applyDraft,
        onDone: (result) => {
          applyDraft(result.draft);
          if (result.fellBack) {
            setFellBack({ provider: result.provider, modelId: result.modelId });
          }
          setDrafting(false);
          cancelDraft = null;
        },
        onError: (message, code) => {
          setDraftError(
            code === 'no-provider'
              ? 'No AI provider configured — add an OpenAI or Anthropic key in Settings.'
              : message,
          );
          setDrafting(false);
          cancelDraft = null;
        },
      },
    );
  };

  // ---- Pick element ---------------------------------------------------------

  const [pickError, setPickError] = createSignal<string | null>(null);

  const pickElement = () => {
    setPickError(null);
    activatePicker().catch((err: unknown) => {
      setPickError(
        err instanceof Error && err.message
          ? err.message
          : 'Cannot activate the picker — open your dev app in the active tab first.',
      );
    });
  };

  const clearGrab = async () => {
    await clearLastGrab();
    void queryClient.invalidateQueries({ queryKey: ['grab'] });
  };

  // ---- Screen recording -------------------------------------------------------

  const [rec, setRec] = createSignal(getRecorderSnapshot());
  onCleanup(subscribeRecorder(setRec));

  const [elapsed, setElapsed] = createSignal(0);
  createEffect(() => {
    if (rec().phase !== 'recording') return;
    const iv = setInterval(
      () => setElapsed(Date.now() - (getRecorderSnapshot().startedAt ?? Date.now())),
      250,
    );
    onCleanup(() => clearInterval(iv));
  });

  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const [attachRec, setAttachRec] = createSignal(true);
  const [copyState, setCopyState] = createSignal<'idle' | 'busy' | 'copied'>('idle');
  const [recActionError, setRecActionError] = createSignal<string | null>(null);

  /** Upload once, reuse the Linear asset URL for both attach and copy. */
  const ensureRecordingUploaded = async (): Promise<string> => {
    const result = getRecorderSnapshot().result;
    if (!result) throw new Error('No recording available.');
    if (result.assetUrl) return result.assetUrl;
    const assetUrl = await uploadFileToLinear(result.blob, `recording-${Date.now()}.gif`);
    markRecordingUploaded(assetUrl);
    return assetUrl;
  };

  const copyRecordingMarkdown = async () => {
    setRecActionError(null);
    setCopyState('busy');
    try {
      const url = await ensureRecordingUploaded();
      await navigator.clipboard.writeText(`![Screen recording](${url})`);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      setCopyState('idle');
      setRecActionError(err instanceof Error ? err.message : 'Copy failed.');
    }
  };

  const downloadRecording = () => {
    const result = rec().result;
    if (!result) return;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = 'linear-grab-recording.gif';
    a.click();
  };

  // ---- Create issue mutation -------------------------------------------------

  const [createError, setCreateError] = createSignal<string | null>(null);
  const [createdIssue, setCreatedIssue] = createSignal<{
    identifier: string;
    url: string;
  } | null>(null);

  const createMut = createMutation(() => ({
    mutationFn: async () => {
      let body = composeIssueBody({
        description: description(),
        reproSteps: reproSteps(),
        expected: expected(),
        actual: actual(),
        grabbed: grab(),
        repo: repo(),
      });
      // Attach the screen recording so the coding agent can watch the interaction.
      const recording = getRecorderSnapshot().result;
      if (recording && attachRec()) {
        const assetUrl = await ensureRecordingUploaded();
        body += `\n\n### Recording\n![Screen recording](${assetUrl})`;
      }
      return createIssue({
        teamId: teamId(),
        title: title(),
        description: body,
        priority: priority(),
        delegateId:
          delegateOn() && settings().cursorAgentId
            ? settings().cursorAgentId
            : undefined,
      });
    },
    onSuccess: (issue) => {
      setCreatedIssue({ identifier: issue.identifier, url: issue.url });
      setCreateError(null);
      setFellBack(null);
      discardRecording();
    },
    onError: (err: Error) => {
      setCreateError(err.message);
    },
  }));

  const canCreate = createMemo(
    () => !!title().trim() && !!teamId() && linearConnected(),
  );

  const resolvedModelId = createMemo(() => {
    const p = provider();
    if (!p) return null;
    return MODELS[p][tier()];
  });

  // ---- Repro step helpers ---------------------------------------------------

  const addStep = () => setReproSteps((s) => [...s, '']);
  const removeStep = (i: number) =>
    setReproSteps((s) => s.filter((_, idx) => idx !== i));
  const updateStep = (i: number, val: string) =>
    setReproSteps((s) => s.map((v, idx) => (idx === i ? val : v)));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="flex h-full flex-col gap-4 overflow-y-auto pt-3 pb-4 pl-3 pr-4">

      {/* ---- Captured element card ----------------------------------------- */}
      <Section title="Captured element">
        <Show
          when={grab()}
          fallback={
            <EmptyState title="No element captured">
              Click "Pick element" below, then use the Linear Grab overlay on your
              dev app. Source info is only available in dev builds — production
              bundles have no fiber debug data.
            </EmptyState>
          }
        >
          {(el) => (
            <div class="bg-surface border-border rounded-lg border p-2.5 flex flex-col gap-1.5">
              <div class="flex items-start justify-between gap-2">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <Show when={el().componentName}>
                    <span class="font-mono text-accent text-[12px]">
                      {'<'}{el().componentName}{'>'}
                    </span>
                  </Show>
                  <Show when={el().source?.filePath}>
                    <span class="font-mono text-[11px] text-text-dim break-all">
                      {el().source!.filePath}
                      {el().source?.lineNumber != null ? `:${el().source!.lineNumber}` : ''}
                    </span>
                  </Show>
                  <span class="text-text-faint text-[10.5px] break-all truncate">
                    {el().pageUrl}
                  </span>
                </div>
                <Button
                  class="shrink-0 h-6 px-2 text-[11px]"
                  variant="ghost"
                  onClick={clearGrab}
                >
                  Clear
                </Button>
              </div>
              <Show when={el().stackContext}>
                <details class="text-[10.5px]">
                  <summary class="text-text-faint cursor-pointer select-none">
                    Component stack
                  </summary>
                  <pre class="font-mono text-text-faint text-[10.5px] overflow-x-auto mt-1 whitespace-pre-wrap break-all">
                    {el().stackContext}
                  </pre>
                </details>
              </Show>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-1.5">
          <Button variant="primary" onClick={pickElement}>
            Pick element
          </Button>
          <Show when={pickError()}>
            <ErrorNote message={pickError()!} />
          </Show>
        </div>
      </Section>

      {/* ---- Screen recording ------------------------------------------------ */}
      <Section title="Recording">
        <Show when={rec().phase === 'idle' || rec().phase === 'error'}>
          <div class="flex flex-col gap-1.5">
            <Button variant="ghost" onClick={() => void startRecording()}>
              <span class="text-danger">●</span> Record interaction
            </Button>
            <span class="text-text-faint text-[10.5px] leading-snug">
              Captures your screen as a looping GIF (max 30s) the coding agent can
              watch. Pick this tab in the share dialog, then reproduce the issue.
            </span>
            <Show when={rec().phase === 'error' && rec().error}>
              <ErrorNote message={rec().error!} />
            </Show>
          </div>
        </Show>

        <Show when={rec().phase === 'recording'}>
          <div class="bg-surface border-border flex items-center gap-2 rounded-lg border p-2.5">
            <span aria-hidden class="bg-danger size-2 shrink-0 animate-pulse rounded-full" />
            <span class="text-text min-w-[5ch] text-[12px] tabular-nums">
              {formatElapsed(elapsed())}
            </span>
            <span class="text-text-faint text-[10.5px]">max 0:30</span>
            <Button variant="primary" class="ml-auto" onClick={() => void stopRecording()}>
              <span class="inline-block min-w-[4ch] text-center">Stop</span>
            </Button>
          </div>
        </Show>

        <Show when={rec().phase === 'processing'}>
          <div class="bg-surface border-border flex items-center gap-2 rounded-lg border p-2.5">
            <Spinner />
            <span class="text-text-dim text-[12px]">Encoding GIF…</span>
          </div>
        </Show>

        <Show when={rec().phase === 'ready' && rec().result}>
          {(result) => (
            <div class="bg-surface border-border flex flex-col gap-2 rounded-lg border p-2.5">
              <img
                src={result().url}
                alt="Screen recording preview"
                class="border-border bg-bg max-h-44 w-full rounded-md border object-contain"
              />
              <span class="text-text-faint text-[10.5px] tabular-nums">
                {(result().blob.size / 1024).toFixed(0)} KB ·{' '}
                {(result().durationMs / 1000).toFixed(1)}s · {result().width}×
                {result().height}
              </span>
              <label class="flex cursor-pointer items-center gap-2 select-none">
                <input
                  type="checkbox"
                  checked={attachRec()}
                  onChange={(e) => setAttachRec(e.currentTarget.checked)}
                  class="accent-accent rounded"
                />
                <span class="text-text text-[12px]">Attach to issue on create</span>
              </label>
              <div class="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  class="h-6 px-2 text-[11px]"
                  loading={copyState() === 'busy'}
                  disabled={!linearConnected()}
                  title={
                    linearConnected()
                      ? 'Uploads to Linear and copies embeddable markdown'
                      : 'Connect Linear in Settings first'
                  }
                  onClick={() => void copyRecordingMarkdown()}
                >
                  <span class="inline-block min-w-[9ch] text-center">
                    {copyState() === 'copied' ? 'Copied!' : 'Copy markdown'}
                  </span>
                </Button>
                <Button variant="ghost" class="h-6 px-2 text-[11px]" onClick={downloadRecording}>
                  Download
                </Button>
                <Button
                  variant="danger"
                  class="ml-auto h-6 px-2 text-[11px]"
                  onClick={discardRecording}
                >
                  Discard
                </Button>
              </div>
              <Show when={recActionError()}>
                <ErrorNote message={recActionError()!} />
              </Show>
            </div>
          )}
        </Show>
      </Section>

      {/* ---- Note + AI drafting -------------------------------------------- */}
      <Section title="AI draft">
        <Field label="Your note">
          <Textarea
            rows={3}
            placeholder="Describe the problem or change in your own words…"
            value={note()}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </Field>

        {/* Tier segmented control */}
        <div class="flex items-center gap-1.5">
          <span class="text-text-faint text-[11px]">Model:</span>
          <div class="flex rounded-md border border-border overflow-hidden">
            {(['fast', 'best'] as const).map((t) => (
              <button
                onClick={() => setTier(t)}
                class={`h-6 px-2.5 text-[11px] font-medium transition-colors cursor-pointer ${
                  tier() === t
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-text-dim hover:text-text'
                }`}
              >
                {t === 'fast' ? 'Fast' : 'Best'}
              </button>
            ))}
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <Show
            when={provider()}
            fallback={
              <Button variant="ghost" class="opacity-60 cursor-default" disabled={false}>
                Add an AI key in Settings
              </Button>
            }
          >
            <Button
              variant="primary"
              loading={drafting()}
              onClick={startDraft}
              disabled={drafting()}
            >
              Draft with AI
            </Button>
          </Show>

          <Show when={resolvedModelId()}>
            <Badge>
              <span class="inline-block min-w-[12ch] text-center">
                {resolvedModelId()}
              </span>
            </Badge>
          </Show>
        </div>

        <Show when={fellBack()}>
          <p class="text-text-faint text-[11px] leading-snug">
            Primary provider failed — drafted with{' '}
            <span class="text-text-dim">{fellBack()!.provider}</span>{' '}
            ({fellBack()!.modelId}).
          </p>
        </Show>

        <Show when={draftError()}>
          <ErrorNote message={draftError()!} />
        </Show>
      </Section>

      {/* ---- Editable form -------------------------------------------------- */}
      <Section title="Issue">
        <Field label="Title">
          <Input
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder="Brief summary of the issue"
          />
        </Field>

        <Field label="Description">
          <Textarea
            rows={6}
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            placeholder="Markdown supported"
          />
        </Field>

        <Field label="Reproduction steps">
          <div class="flex flex-col gap-1">
            {/* Index (not For): keyed by position, so editing a step doesn't
                recreate the input and steal focus mid-keystroke. */}
            <Index each={reproSteps()}>
              {(step, i) => (
                <div class="flex items-center gap-1">
                  <span class="text-text-faint text-[11px] tabular-nums w-4 shrink-0 text-right">
                    {i + 1}.
                  </span>
                  <Input
                    class="flex-1"
                    value={step()}
                    onInput={(e) => updateStep(i, e.currentTarget.value)}
                    placeholder={`Step ${i + 1}`}
                  />
                  <button
                    onClick={() => removeStep(i)}
                    class="text-text-faint hover:text-danger shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer text-[12px] leading-none"
                    aria-label="Remove step"
                  >
                    ×
                  </button>
                </div>
              )}
            </Index>
            <Button variant="ghost" class="self-start h-6 px-2 text-[11px]" onClick={addStep}>
              + Add step
            </Button>
          </div>
        </Field>

        <Field label="Expected">
          <Textarea
            rows={2}
            value={expected()}
            onInput={(e) => setExpected(e.currentTarget.value)}
            placeholder="What should happen"
          />
        </Field>

        <Field label="Actual">
          <Textarea
            rows={2}
            value={actual()}
            onInput={(e) => setActual(e.currentTarget.value)}
            placeholder="What actually happens"
          />
        </Field>

        <Field label="Priority">
          <Select
            value={priority()}
            onChange={(e) => setPriority(Number(e.currentTarget.value))}
          >
            <For each={Object.entries(PRIORITY_LABELS)}>
              {([val, label]) => (
                <option value={val}>{label}</option>
              )}
            </For>
          </Select>
        </Field>

        <Show
          when={linearConnected()}
          fallback={
            <ErrorNote message="Connect Linear in Settings to create issues." />
          }
        >
          <Field label="Team">
            <Show
              when={!teamsQuery.isLoading}
              fallback={
                <Select disabled>
                  <option>Loading teams…</option>
                </Select>
              }
            >
              <Select
                value={teamId()}
                onChange={(e) => setTeamId(e.currentTarget.value)}
              >
                <option value="">Select a team…</option>
                <For each={teamsQuery.data ?? []}>
                  {(team) => (
                    <option value={team.id}>{team.name}</option>
                  )}
                </For>
              </Select>
            </Show>
          </Field>
        </Show>

        <Field
          label="Repo"
          hint="Appended as [repo=…] so Cursor works in the right repository."
        >
          <Input
            value={repo()}
            onInput={(e) => setRepo(e.currentTarget.value)}
            placeholder="owner/repository"
          />
        </Field>

        {/* Delegate toggle */}
        <div class="flex flex-col gap-1">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={delegateOn()}
              disabled={!settings().cursorAgentId}
              onChange={(e) => setDelegateOn(e.currentTarget.checked)}
              class="rounded accent-accent"
            />
            <span class="text-[12px] text-text">
              Delegate to{' '}
              <span class="text-text-dim">
                {settings().cursorAgentName ?? 'Cursor'}
              </span>{' '}
              on create
            </span>
          </label>
          <Show when={!settings().cursorAgentId}>
            <span class="text-text-faint text-[10.5px] leading-snug pl-5">
              Pick the Cursor agent in Settings
            </span>
          </Show>
        </div>
      </Section>

      {/* ---- Create button + result ----------------------------------------- */}
      <div class="flex flex-col gap-2">
        <Show when={createError()}>
          <ErrorNote message={createError()!} />
        </Show>

        <Show when={createdIssue()}>
          {(issue) => (
            <div class="bg-surface border-border rounded-lg border p-2.5 flex items-center justify-between gap-2">
              <a
                href={issue().url}
                target="_blank"
                rel="noopener noreferrer"
                class="text-accent font-mono text-[12px] hover:underline"
              >
                {issue().identifier}
              </a>
              <Button
                variant="ghost"
                class="h-6 px-2 text-[11px]"
                onClick={() => {
                  setCreatedIssue(null);
                  setFellBack(null);
                  props.onCreated();
                }}
              >
                View activity
              </Button>
            </div>
          )}
        </Show>

        <Button
          variant="primary"
          loading={createMut.isPending}
          disabled={!canCreate()}
          onClick={() => createMut.mutate()}
        >
          Create issue
        </Button>
      </div>
    </div>
  );
}
