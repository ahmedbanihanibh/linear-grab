import {
  createSignal,
  createMemo,
  createEffect,
  Show,
  For,
  Index,
  onCleanup,
} from 'solid-js';
import { persistentSignal } from '../persist';
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
import {
  fetchTeams,
  createIssue,
  createComment,
  fetchTeamStates,
  updateIssueState,
} from '@/lib/linear/api';
import { uploadAsset } from '@/lib/assetUpload';
import { createBridgeTask } from '@/lib/bridge';
import { announceIssue } from '@/lib/notify';
import { fetchDevLogTail } from '@/lib/logs';
import { formatConsoleTail, getConsoleTail } from '@/lib/consoleCapture';
import { searchIssues } from '@/lib/linear/api';
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

  const [title, setTitle] = persistentSignal('draft:title', '');
  const [description, setDescription] = persistentSignal('draft:description', '');
  const [reproSteps, setReproSteps] = persistentSignal<string[]>('draft:steps', []);
  const [expected, setExpected] = persistentSignal('draft:expected', '');
  const [actual, setActual] = persistentSignal('draft:actual', '');
  const [impact, setImpact] = persistentSignal('draft:impact', '');
  const [analysisNotes, setAnalysisNotes] = persistentSignal('draft:analysis', '');
  const [nextSteps, setNextSteps] = persistentSignal('draft:next-steps', '');
  const [priority, setPriority] = persistentSignal('draft:priority', 0);
  const [teamId, setTeamId] = createSignal(settings().defaultTeamId ?? '');
  const [repo, setRepo] = createSignal(settings().defaultRepo ?? '');
  /** Who executes the issue: Cursor cloud agent, local Claude Code, or nobody. */
  const [target, setTarget] = persistentSignal<'cursor' | 'local' | 'none'>('draft:target', 'none');
  /** Claude Code model for local delegation ('' = its default). */
  const [localModel, setLocalModel] = persistentSignal('draft:local-model', '');
  /** Per-draft Cursor cloud model override → [model=…] ('' = Settings default). */
  const [cloudModel, setCloudModel] = persistentSignal('draft:cloud-model', '');
  /** Isolated git worktree for local delegation (parallel-safe). */
  const [useWorktree, setUseWorktree] = persistentSignal('draft:worktree', false);
  /** Attach captured console errors (auto-on when any exist). */
  const [includeConsole, setIncludeConsole] = createSignal(true);
  const [consoleCount, setConsoleCount] = createSignal(getConsoleTail().length);
  createEffect(() => {
    const iv = setInterval(() => setConsoleCount(getConsoleTail().length), 3_000);
    onCleanup(() => clearInterval(iv));
  });

  // Duplicate detection: relevance-search Linear as the title settles.
  const [dupTerm, setDupTerm] = createSignal('');
  createEffect(() => {
    const t = title().trim();
    const timer = setTimeout(() => setDupTerm(t.length >= 8 ? t : ''), 600);
    onCleanup(() => clearTimeout(timer));
  });
  const dupQuery = createQuery(() => ({
    queryKey: ['dup-search', dupTerm()],
    queryFn: () => searchIssues(dupTerm()),
    enabled: !!dupTerm() && linearConnected(),
    staleTime: 30_000,
  }));
  const [note, setNote] = persistentSignal('draft:note', '');

  // Pasted images (⌘V straight into the note) — attached to the issue on create.
  const [pasted, setPasted] = createSignal<Array<{ id: number; dataUrl: string }>>([]);
  const onNotePaste = (e: ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file || file.size > 8_000_000) continue;
      const reader = new FileReader();
      reader.onload = () =>
        setPasted((prev) =>
          [...prev, { id: Date.now() + Math.random(), dataUrl: reader.result as string }].slice(-6),
        );
      reader.readAsDataURL(file);
    }
  };
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


  const [copiedPrompt, setCopiedPrompt] = createSignal(false);
  const copyPrompt = async () => {
    const body = composeIssueBody({
      description: description(),
      reproSteps: reproSteps(),
      expected: expected(),
      actual: actual(),
      impact: impact(),
      analysisNotes: analysisNotes(),
      suggestedNextSteps: nextSteps(),
      grabs: grabQuery.data ?? [],
      // NO repo/model tags, NO agent instructions — this is a clean prompt
      // for a local session: no Slack, no video, no Linear closeout.
    });
    const text = `Fix this issue in the current repo. Test the change hands-on before calling it done.\n\n# ${title().trim() || 'Issue'}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

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

    // Ground the draft's Analysis/Notes in server logs + client console errors.
    const serverTail =
      settings().logUrl && includeLogs()
        ? await fetchDevLogTail({ logUrl: settings().logUrl, logLines: 40 }).catch(() => undefined)
        : undefined;
    const consoleTail = includeConsole() ? formatConsoleTail(15) : null;
    const logs =
      [
        serverTail ? `--- dev server ---\n${serverTail}` : null,
        consoleTail ? `--- browser console ---\n${consoleTail}` : null,
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;

    // Host-agnostic: extension routes through the worker port; page mode
    // (Safari/Firefox/any browser) streams in-process.
    cancelDraft = startDraftStream(
      {
        note: pasted().length
          ? `${note()}\n\n(${pasted().length} pasted screenshot(s) will be attached to the issue.)`
          : note(),
        grabbed: grab() ?? null,
        grabbedList: grabQuery.data ?? undefined,
        teamName: selectedTeamName(),
        tier: tier(),
        template: buildAgentInstructions(settings()),
        logs,
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
        model: cloudModel().trim() || settings().cursorModel,
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
      // Pasted screenshots from the note.
      const pastedNow = pasted();
      for (const [i, img] of pastedNow.entries()) {
        try {
          const url = await uploadAsset(dataUrlToBlob(img.dataUrl), `pasted-${Date.now()}-${i}.png`);
          body += `${i === 0 ? '\n\n### Attachments' : ''}\n![pasted screenshot ${i + 1}](${url})`;
        } catch {
          failed.push(`pasted image ${i + 1}`);
        }
      }
      // Client console errors — the browser-side twin of the server logs.
      if (includeConsole()) {
        const consoleTail = formatConsoleTail(30);
        if (consoleTail) {
          body += `\n\n### Console errors (client)\n\`\`\`\n${consoleTail}\n\`\`\``;
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
        projectId: settings().defaultProjectId || undefined,
        labelIds: settings().defaultLabelIds?.length ? settings().defaultLabelIds : undefined,
      });
      // Local delegation: hand the composed issue to the running Claude Code
      // bridge — the Linear issue stays the single registry either way. The
      // task runs with bypassPermissions + your Linear key in env, so the
      // agent closes the SAME loop as the cloud one: test → PR → update the
      // ticket → move it to review.
      let localTask = false;
      if (target() === 'local') {
        try {
          const closeout = [
            `You are delegated Linear issue ${issue.identifier} (${issue.url}).`,
            '',
            body,
            '',
            '## Closeout — do ALL of this autonomously when the fix is verified (permissions are granted):',
            `1. Create a branch (e.g. fix/${issue.identifier.toLowerCase()}-short-slug), commit, push.`,
            `2. Open a PR: \`gh pr create\` — reference ${issue.identifier} and ${issue.url} in the body so Linear links it.`,
            '3. Update the Linear issue via its GraphQL API (https://api.linear.app/graphql) using the LINEAR_API_KEY env var as the Authorization header:',
            `   - commentCreate on issue ${issue.identifier}: one-line fix summary + root cause + the PR link.`,
            "   - Move it to review: query the team's workflowStates, then issueUpdate with the review/'In Review' stateId.",
            '4. Announce the finished fix on every channel whose token appears in the instructions above (Slack chat.postMessage + files upload, Telegram sendMessage/sendVideo) — include: what was broken, the one-line fix, the Linear issue link, the PR link, and the demo recording if you made one. End with "👉 Review the PR".',
          ].join('\n');
          await createBridgeTask(
            `${issue.identifier} — ${title()}`,
            useWorktree()
              ? `${closeout}\n\nNote: you are running in an ISOLATED git worktree on a dedicated branch (already checked out) — commit and push THAT branch for the PR; do not switch back to main.`
              : closeout,
            {
              model: localModel() || undefined,
              permissionMode: 'bypassPermissions',
              worktree: useWorktree(),
              env: settings().linearApiKey
                ? { LINEAR_API_KEY: settings().linearApiKey! }
                : undefined,
            },
          );
          localTask = true;
          // Mirror what Cursor does on delegation: move the issue to the
          // team's started state so it's In Progress while the agent works.
          try {
            const states = await fetchTeamStates(teamId());
            const started = states
              .filter((st) => st.type === 'started')
              .sort((a, b) => a.position - b.position)[0];
            if (started) await updateIssueState(issue.id, started.id);
          } catch {
            /* non-fatal — the agent's closeout still moves it later */
          }
          // Make the delegation visible in Activity immediately.
          await createComment(
            issue.id,
            `🖥️ Delegated to **local Claude Code** on this machine (Linear Grab bridge). Live status, conversation, and steering in the panel's Local tab. The agent will post its fix summary + PR here and move this issue to review when done.`,
          ).catch(() => {});
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
      setPasted([]);
      // The issue owns this content now — clear the (reload-persisted) form
      // so leftovers can't leak into the next draft.
      setNote('');
      setTitle('');
      setDescription('');
      setReproSteps([]);
      setExpected('');
      setActual('');
      setImpact('');
      setAnalysisNotes('');
      setNextSteps('');
      setPriority(0);
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
            placeholder="Describe the problem or change in your own words… (paste screenshots here too)"
            value={note()}
            onInput={(e) => setNote(e.currentTarget.value)}
            onPaste={onNotePaste}
          />
        </Field>

        {/* Pasted image attachments */}
        <Show when={pasted().length > 0}>
          <div class="flex flex-wrap gap-1.5">
            <For each={pasted()}>
              {(img) => (
                <div class="border-border relative overflow-hidden rounded-md border">
                  <img src={img.dataUrl} alt="Pasted attachment" class="block h-16 w-16 object-cover" />
                  <button
                    class="bg-bg/80 text-text-dim hover:text-danger absolute top-0.5 right-0.5 grid size-4 cursor-pointer place-items-center rounded text-[10px] leading-none"
                    title="Remove"
                    aria-label="Remove pasted image"
                    onClick={() => setPasted((prev) => prev.filter((x) => x.id !== img.id))}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
            <span class="text-text-faint self-end text-[10.5px]">
              attached on create
            </span>
          </div>
        </Show>

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

        {/* Duplicate detection — catch it BEFORE delegating an agent to it */}
        <Show when={(dupQuery.data ?? []).length > 0}>
          <div class="border-warn/40 bg-surface rounded-md border px-2.5 py-2">
            <p class="text-warn mb-1 text-[10.5px] font-semibold tracking-wide uppercase">
              Possibly related — check before creating
            </p>
            <For each={dupQuery.data!.slice(0, 3)}>
              {(iss) => (
                <div class="flex min-w-0 items-center gap-1.5 py-0.5">
                  <span class="font-mono text-text-dim shrink-0 text-[10.5px]">
                    {iss.identifier}
                  </span>
                  <a
                    href={iss.url}
                    target="_blank"
                    rel="noreferrer"
                    class="text-accent min-w-0 truncate text-[11px] hover:underline"
                    title={iss.title}
                  >
                    {iss.title}
                  </a>
                  <Badge class="ml-auto shrink-0">{iss.state.name}</Badge>
                </div>
              )}
            </For>
          </div>
        </Show>

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

        {/* Cursor cloud model for THIS issue — [model=…] tag */}
        <Show when={target() === 'cursor'}>
          <Field
            label="Cloud model"
            hint={`Sent as [model=…]. Empty = ${settings().cursorModel ? `your default (${settings().cursorModel})` : "Cursor's default"}.`}
          >
            <Input
              placeholder={settings().cursorModel || "Cursor's default — e.g. claude-opus-4-8, composer"}
              value={cloudModel()}
              onInput={(e) => setCloudModel(e.currentTarget.value)}
            />
          </Field>
        </Show>

        {/* Local model pick — changeable later per-task in the Local tab */}
        <Show when={target() === 'local'}>
          <Field label="Local model" hint="Switchable while running from the Local tab.">
            <Select value={localModel()} onChange={(e) => setLocalModel(e.currentTarget.value)}>
              <option value="" selected={localModel() === ''}>Claude Code default</option>
              <option value="fable" selected={localModel() === 'fable'}>Fable 5</option>
              <option value="opus" selected={localModel() === 'opus'}>Opus</option>
              <option value="sonnet" selected={localModel() === 'sonnet'}>Sonnet</option>
              <option value="haiku" selected={localModel() === 'haiku'}>Haiku</option>
            </Select>
          </Field>

          {/* Opt-in isolation: own git worktree + branch, parallel-safe */}
          <label class="flex cursor-pointer items-center gap-2 select-none">
            <input
              type="checkbox"
              checked={useWorktree()}
              onChange={(e) => setUseWorktree(e.currentTarget.checked)}
              class="accent-accent rounded"
            />
            <span class="text-text text-[12px]">
              Isolated worktree{' '}
              <span class="text-text-dim">— own branch, run agents in parallel safely</span>
            </span>
          </label>
        </Show>

        {/* Console errors toggle (only when the buffer caught something) */}
        <Show when={consoleCount() > 0}>
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeConsole()}
              onChange={(e) => setIncludeConsole(e.currentTarget.checked)}
              class="rounded accent-accent"
            />
            <span class="text-[12px] text-text">
              Attach console errors{' '}
              <span class="text-text-dim tabular-nums">({consoleCount()} captured)</span>
            </span>
          </label>
        </Show>

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

        <div class="flex items-center gap-2">
            <Button
              variant="ghost"
              class="h-9 shrink-0 px-3"
              title={
                copiedPrompt()
                  ? 'Copied!'
                  : 'Copy as a clean prompt — issue context only (no Slack/video/Linear closeout), paste into a local Claude Code session'
              }
              aria-label="Copy issue as prompt"
              onClick={() => void copyPrompt()}
            >
              <Show when={copiedPrompt()} fallback={
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                  <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
                </svg>
              }>
                <span class="text-success text-[11px]">✓</span>
              </Show>
            </Button>
            <Button
              variant="primary"
              class="h-9 min-w-0 flex-1"
              loading={createMut.isPending}
              disabled={!canCreate()}
              onClick={() => createMut.mutate()}
            >
              Create issue
            </Button>
          </div>
      </div>
    </div>
  );
}
