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
import { getSettings, getLastGrab } from '@/lib/storage';
import { startDraftStream } from '@/lib/draftClient';
import {
  getRecorderSnapshot,
  subscribeRecorder,
  discardRecording,
  markRecordingUploaded,
} from '@/lib/recorder';
import { fetchTeams, createIssue } from '@/lib/linear/api';
import { uploadAsset } from '@/lib/assetUpload';
import { createBridgeTask } from '@/lib/bridge';
import { announceIssue } from '@/lib/notify';
import { fetchDevLogTail } from '@/lib/logs';
import { dataUrlToBlob } from '@/lib/elementShot';
import { resolveProvider, MODELS } from '@/lib/ai/providers';
import { composeIssueBody, buildAgentInstructions } from '@/lib/ai/prompt';
import { openPanelTo } from '../nav';
import {
  Button,
  Input,
  Textarea,
  Select,
  Field,
  Section,
  Badge,
  ErrorNote,
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
  const [impact, setImpact] = createSignal('');
  const [analysisNotes, setAnalysisNotes] = createSignal('');
  const [nextSteps, setNextSteps] = createSignal('');
  const [priority, setPriority] = createSignal(0);
  const [teamId, setTeamId] = createSignal(settings().defaultTeamId ?? '');
  const [repo, setRepo] = createSignal(settings().defaultRepo ?? '');
  /** Who executes the issue: Cursor cloud agent, local Claude Code, or nobody. */
  const [target, setTarget] = createSignal<'cursor' | 'local' | 'none'>('none');
  const [note, setNote] = createSignal('');
  const [tier, setTier] = createSignal<AiTier>('fast');
  const [includeLogs, setIncludeLogs] = createSignal(true);

  // When settings load, initialise defaults (runs exactly once on first real data).
  let defaultsApplied = false;
  createEffect(() => {
    const s = settingsQuery.data;
    if (defaultsApplied || !s) return;
    defaultsApplied = true;
    setTeamId(s.defaultTeamId ?? '');
    setRepo(s.defaultRepo ?? '');
    setTarget(s.cursorAgentId ? 'cursor' : 'none');
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
    impact: string;
    analysisNotes: string;
    suggestedNextSteps: string;
    priority: number;
  }>) => {
    if (d.title !== undefined) setTitle(d.title);
    if (d.description !== undefined) setDescription(d.description);
    if (d.reproSteps !== undefined) setReproSteps(d.reproSteps);
    if (d.expected !== undefined) setExpected(d.expected);
    if (d.actual !== undefined) setActual(d.actual);
    if (d.impact !== undefined) setImpact(d.impact);
    if (d.analysisNotes !== undefined) setAnalysisNotes(d.analysisNotes);
    if (d.suggestedNextSteps !== undefined) setNextSteps(d.suggestedNextSteps);
    if (d.priority !== undefined) setPriority(d.priority);
  };

  const startDraft = async () => {
    if (!provider()) return;
    setDrafting(true);
    setDraftError(null);
    setFellBack(null);
    stopDraft();

    // Ground the draft's Analysis/Notes in recent server logs when configured.
    const logs =
      settings().logUrl && includeLogs()
        ? await fetchDevLogTail({ logUrl: settings().logUrl, logLines: 40 }).catch(() => undefined)
        : undefined;

    // Host-agnostic: extension routes through the worker port; page mode
    // (Safari/Firefox/any browser) streams in-process.
    cancelDraft = startDraftStream(
      {
        note: note(),
        grabbed: grab() ?? null,
        grabbedList: grabQuery.data ?? undefined,
        teamName: selectedTeamName(),
        tier: tier(),
        template: buildAgentInstructions(settings()),
        logs: logs ?? undefined,
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

  // ---- Capture state (owned by the Capture tab; summarized here) --------------

  const [rec, setRec] = createSignal(getRecorderSnapshot());
  onCleanup(subscribeRecorder(setRec));

  /** Upload once, reuse the Linear asset URL. */
  const ensureRecordingUploaded = async (): Promise<string> => {
    const result = getRecorderSnapshot().result;
    if (!result) throw new Error('No recording available.');
    if (result.assetUrl) return result.assetUrl;
    const assetUrl = await uploadAsset(result.blob, `recording-${Date.now()}.gif`);
    markRecordingUploaded(assetUrl);
    return assetUrl;
  };

  // ---- Create issue mutation -------------------------------------------------

  const [createError, setCreateError] = createSignal<string | null>(null);
  const [createWarning, setCreateWarning] = createSignal<string | null>(null);
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
        impact: impact(),
        analysisNotes: analysisNotes(),
        suggestedNextSteps: nextSteps(),
        grabs: grabQuery.data ?? [],
        repo: repo(),
        model: settings().cursorModel,
        agentInstructions: buildAgentInstructions(settings()),
      });
      // Attach GIF + element screenshot automatically — BOTH best-effort:
      // Linear's storage rejects cross-origin browser uploads in some
      // browsers, and a blocked attachment must NEVER block the issue.
      setCreateWarning(null);
      const failed: string[] = [];
      const recorder = getRecorderSnapshot();
      const recording = recorder.result;
      if (recording && recorder.attachOnCreate) {
        try {
          const assetUrl = await ensureRecordingUploaded();
          body += `\n\n### Recording\n![Screen recording](${assetUrl})`;
        } catch {
          failed.push('recording');
        }
      }
      const shots = (grabQuery.data ?? []).filter((g) => g.screenshotDataUrl).slice(0, 3);
      for (const [i, g] of shots.entries()) {
        try {
          const url = await uploadAsset(
            dataUrlToBlob(g.screenshotDataUrl!),
            `element-${Date.now()}-${i}.png`,
          );
          const label = g.componentName ? `<${g.componentName}>` : (g.tagName ?? 'element');
          body += `\n\n### Element location${shots.length > 1 ? ` — ${label}` : ''}\n![Highlighted element in context](${url})`;
        } catch {
          failed.push(`screenshot${shots.length > 1 ? ` ${i + 1}` : ''}`);
        }
      }
      // Dev-server log tail — full debug context for the agent.
      if (settings().logUrl && includeLogs()) {
        try {
          const tail = await fetchDevLogTail(settings());
          if (tail) {
            const n = Math.min(500, Math.max(10, settings().logLines ?? 100));
            body += `\n\n### Dev server logs (last ${n} lines)\n\`\`\`\n${tail}\n\`\`\``;
          }
        } catch {
          failed.push('server logs (fetch failed — is the Log URL serving the file?)');
        }
      }
      if (failed.length) {
        const uploadsFailed = failed.some((f) => !f.startsWith('server logs'));
        setCreateWarning(
          `Skipped: ${failed.join(', ')} — issue created without ${failed.length > 1 ? 'them' : 'it'}.${
            uploadsFailed
              ? ' Real fix for uploads: run `npx linear-grab-bridge` in the repo (uploads relay through it) or set the GitHub fallback in Settings.'
              : ''
          }`,
        );
      }
      const issue = await createIssue({
        teamId: teamId(),
        title: title(),
        description: body,
        priority: priority(),
        delegateId: target() === 'cursor' ? settings().cursorAgentId : undefined,
      });
      // Local delegation: hand the composed issue to the running Claude Code
      // bridge — the Linear issue stays the single registry either way.
      let localTask = false;
      if (target() === 'local') {
        try {
          await createBridgeTask(
            `${issue.identifier} — ${title()}`,
            `You are delegated Linear issue ${issue.identifier} (${issue.url}).\n\n${body}\n\nWork in this repository until the issue is resolved, following the Agent instructions above.`,
          );
          localTask = true;
        } catch {
          setCreateWarning(
            'Issue created, but the local bridge is unreachable — run `npx linear-grab-bridge` in the repo and re-delegate from the Local tab.',
          );
        }
      }
      // Announce to Slack/Telegram (best-effort, when configured): issue link,
      // summary, executor, and the demo URL when one uploaded.
      const notifyFailed = await announceIssue(settings(), {
        identifier: issue.identifier,
        title: title(),
        url: issue.url,
        summary: description(),
        impact: impact(),
        repo: repo() || settings().defaultRepo,
        demoUrl: getRecorderSnapshot().result?.assetUrl,
        executor: target(),
      });
      if (notifyFailed.length) {
        setCreateWarning(
          `${notifyFailed.join(' + ')} announcement failed — check the token/channel in Settings.`,
        );
      }
      return { ...issue, localTask };
    },
    onSuccess: (issue) => {
      setCreatedIssue({ identifier: issue.identifier, url: issue.url });
      setCreateError(null);
      setFellBack(null);
      discardRecording();
      if (issue.localTask) openPanelTo('local');
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

      {/* ---- Context summary — full management lives in the Capture tab ------- */}
      <div class="bg-surface border-border flex items-center gap-2 rounded-lg border px-2.5 py-2">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-text-dim text-[11px] font-medium">Attached context</span>
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <Show
              when={grab()}
              fallback={<Badge class="text-text-faint">No element</Badge>}
            >
              <Badge class="text-accent max-w-full">
                <span class="truncate font-mono">
                  {grab()!.componentName
                    ? `<${grab()!.componentName}>`
                    : (grab()!.source?.filePath?.split('/').pop() ?? 'element')}
                </span>
              </Badge>
            </Show>
            <Show when={grab()?.screenshotDataUrl}>
              <Badge class="text-success">screenshot ✓</Badge>
            </Show>
            <Show when={rec().result}>
              <Badge class={rec().attachOnCreate ? 'text-success' : 'text-text-faint'}>
                gif {(rec().result!.durationMs / 1000).toFixed(0)}s
                {rec().attachOnCreate ? ' ✓' : ' (off)'}
              </Badge>
            </Show>
            <Show when={(grabQuery.data?.length ?? 0) > 1}>
              <Badge>+{grabQuery.data!.length - 1} more</Badge>
            </Show>
            <Show when={rec().phase === 'recording'}>
              <Badge class="text-danger">● recording…</Badge>
            </Show>
          </div>
        </div>
        <Button
          variant="ghost"
          class="size-7 shrink-0 px-0"
          title="Manage in the Capture tab — elements, screenshots, recording"
          aria-label="Open Capture tab"
          onClick={() => openPanelTo('capture')}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
            <path d="M5.5 3.5 6.6 2h2.8l1.1 1.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V5A1.5 1.5 0 0 1 3 3.5h2.5Z" />
            <circle cx="8" cy="8.2" r="2.4" />
          </svg>
        </Button>
      </div>

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

        {/* Tier segmented control — label left, chooser right */}
        <div class="flex items-center justify-between gap-1.5">
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

        <div class="flex flex-col gap-1.5">
          <Show
            when={provider()}
            fallback={
              <Button variant="ghost" class="w-full opacity-60 cursor-default" disabled={false}>
                Add an AI key in Settings
              </Button>
            }
          >
            <Button
              variant="primary"
              class="w-full"
              loading={drafting()}
              onClick={startDraft}
              disabled={drafting()}
            >
              Draft with AI
            </Button>
          </Show>

          <Show when={resolvedModelId()}>
            <div class="flex justify-end">
              <Badge>
                <span class="inline-block min-w-[12ch] text-center">
                  {resolvedModelId()}
                </span>
              </Badge>
            </div>
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
            class="h-8 text-[13px] font-medium"
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

        <Field label="Impact">
          <Textarea
            rows={2}
            value={impact()}
            onInput={(e) => setImpact(e.currentTarget.value)}
            placeholder="Who/what is affected and how badly"
          />
        </Field>

        <Field label="Analysis / Notes">
          <Textarea
            rows={3}
            value={analysisNotes()}
            onInput={(e) => setAnalysisNotes(e.currentTarget.value)}
            placeholder={'- Likely root cause…'}
          />
        </Field>

        <Field label="Suggested next steps">
          <Textarea
            rows={3}
            value={nextSteps()}
            onInput={(e) => setNextSteps(e.currentTarget.value)}
            placeholder={'- Concrete fix suggestion…'}
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
                    // selected attr: options load async, so the Select's value
                    // prop alone won't re-apply once they appear.
                    <option value={team.id} selected={team.id === teamId()}>
                      {team.name}
                    </option>
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

        {/* Executor — cloud agent, local Claude Code, or nobody */}
        <Field
          label="Delegate to"
          hint={
            target() === 'local'
              ? 'Requires `npx linear-grab-bridge` running in the repo — track it in the Local tab.'
              : target() === 'cursor' && !settings().cursorAgentId
                ? 'Pick the Cursor agent in Settings first.'
                : undefined
          }
        >
          <Select
            value={target()}
            onChange={(e) => setTarget(e.currentTarget.value as 'cursor' | 'local' | 'none')}
          >
            <option value="cursor" disabled={!settings().cursorAgentId} selected={target() === 'cursor'}>
              {settings().cursorAgentName ?? 'Cursor'} — cloud agent
            </option>
            <option value="local" selected={target() === 'local'}>
              Local Claude Code (bridge)
            </option>
            <option value="none" selected={target() === 'none'}>
              No one — just create the issue
            </option>
          </Select>
        </Field>

        {/* Dev-server logs toggle (only when a log URL is configured) */}
        <Show when={settings().logUrl}>
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeLogs()}
              onChange={(e) => setIncludeLogs(e.currentTarget.checked)}
              class="rounded accent-accent"
            />
            <span class="text-[12px] text-text">
              Attach dev server logs{' '}
              <span class="text-text-dim tabular-nums">
                (last {Math.min(500, Math.max(10, settings().logLines ?? 100))} lines)
              </span>
            </span>
          </label>
        </Show>
      </Section>

      {/* ---- Create button + result — sticky so the primary action is always
             reachable without scrolling past the whole form (HIG: clear focus). */}
      <div class="bg-bg border-border sticky bottom-0 z-10 -mb-4 flex flex-col gap-2 border-t pt-2.5 pb-3">
        <Show when={createError()}>
          <ErrorNote message={createError()!} />
        </Show>

        <Show when={createWarning()}>
          <p class="text-warn text-[11px] leading-snug">{createWarning()}</p>
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
