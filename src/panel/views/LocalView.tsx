import { createEffect, createMemo, createSignal, For, Index, Show } from 'solid-js';
import { persistentSignal } from '../persist';
import { createQuery, createMutation, useQueryClient } from '@tanstack/solid-query';
import {
  fetchBridgeHealth,
  fetchBridgeTask,
  fetchBridgeDiff,
  listBridgeTasks,
  removeBridgeWorktree,
  sendBridgeMessage,
  setBridgeModel,
  stopBridgeTask,
  resumeCommand,
  type BridgeTask,
} from '@/lib/bridge';
import { fetchMyIssues } from '@/lib/linear/api';
import { getLastGrab } from '@/lib/storage';
import { activatePicker } from '@/lib/picker';
import { buildCaptureBlock } from '@/lib/captureShare';
import { openPanelTo, grabSink, setGrabSink } from '../nav';
import { Button, Badge, EmptyState, ExtLink, Select, Spinner, Textarea, timeAgo } from '../components/ui';
import { renderMarkdown } from '../components/markdown';

const MODEL_OPTIONS = [
  { id: '', label: 'Default model' },
  { id: 'fable', label: 'Fable 5' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

const fmtTokens = (n?: number) =>
  n == null ? '–' : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);

/**
 * Local tab — interactive workspace for LOCAL Claude Code sessions via the
 * bridge: live conversation, mid-run messages, model switching, usage
 * telemetry, resumable session ids, persistent history. Cloud agents live in
 * Activity; this is their local twin — same issues, same tracker.
 */
export default function LocalView() {
  const queryClient = useQueryClient();

  const health = createQuery(() => ({
    queryKey: ['bridge-health'],
    queryFn: fetchBridgeHealth,
    refetchInterval: 5_000,
    retry: 0,
  }));

  const tasks = createQuery(() => ({
    queryKey: ['bridge-tasks'],
    queryFn: listBridgeTasks,
    refetchInterval: 3_000,
    enabled: !!health.data?.ok,
  }));

  const [expandedId, setExpandedId] = createSignal<string | null>(null);

  // Cross-reference bridge tasks (titled "TES-55 — …") with the Linear issues
  // so every card links back to its ticket. Shares Activity's query cache.
  const issues = createQuery(() => ({
    queryKey: ['my-issues'],
    queryFn: fetchMyIssues,
    staleTime: 15_000,
  }));
  const issueFor = (task: BridgeTask) => {
    const identifier = task.title.match(/^([A-Z][A-Z0-9]*-\d+)/)?.[1];
    return identifier ? issues.data?.find((i) => i.identifier === identifier) : undefined;
  };

  const detail = createQuery(() => ({
    queryKey: ['bridge-task', expandedId()],
    queryFn: () => fetchBridgeTask(expandedId()!),
    refetchInterval: 1_500,
    enabled: !!expandedId() && !!health.data?.ok,
  }));

  const diff = createQuery(() => ({
    queryKey: ['bridge-diff', expandedId()],
    queryFn: () => fetchBridgeDiff(expandedId()!),
    refetchInterval: 6_000,
    enabled: !!expandedId() && !!health.data?.ok,
  }));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['bridge-tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['bridge-task', expandedId()] });
  };

  const stopMut = createMutation(() => ({
    mutationFn: (id: string) => stopBridgeTask(id),
    onSuccess: invalidate,
  }));

  const [message, setMessage] = persistentSignal('local:message', '');
  const [attachBusy, setAttachBusy] = createSignal(false);

  // Pick elements straight into the follow-up message (grab-sink 'local').
  const [pickStartedAt, setPickStartedAt] = createSignal(0);
  const grabQuery = createQuery(() => ({
    queryKey: ['grab'],
    queryFn: getLastGrab,
    enabled: grabSink() === 'local',
  }));
  const pickForMessage = () => {
    setPickStartedAt(Date.now());
    setGrabSink('local');
    void activatePicker().catch(() => setGrabSink('capture'));
  };
  createEffect(() => {
    if (grabSink() !== 'local') return;
    const fresh = (grabQuery.data ?? []).filter((g) => g.grabbedAt >= pickStartedAt());
    if (!fresh.length) return;
    const refs = fresh
      .map((g) => {
        const loc = g.source?.filePath
          ? ` — \`${g.source.filePath}${g.source.lineNumber != null ? `:${g.source.lineNumber}` : ''}\``
          : '';
        return `- \`<${g.componentName ?? g.tagName ?? 'element'}>\`${loc}`;
      })
      .join('\n');
    setMessage((prev) => `${prev ? `${prev}\n` : ''}${refs}\n`);
    setGrabSink('capture');
  });

  // Attach EVERYTHING captured (refs + screenshots + recording GIF) to the message.
  const attachCaptures = async () => {
    setAttachBusy(true);
    try {
      const block = await buildCaptureBlock();
      if (block) setMessage((prev) => `${prev ? `${prev}\n` : ''}${block}\n`);
    } finally {
      setAttachBusy(false);
    }
  };
  const sendMut = createMutation(() => ({
    mutationFn: (args: { id: string; text: string }) => sendBridgeMessage(args.id, args.text),
    onSuccess: () => {
      setMessage('');
      invalidate();
    },
  }));

  const modelMut = createMutation(() => ({
    mutationFn: (args: { id: string; model: string }) => setBridgeModel(args.id, args.model),
    onSuccess: (updated) => {
      // Write-through so the select reflects the choice INSTANTLY — waiting
      // for the next poll looked like the change "didn't take".
      queryClient.setQueryData<BridgeTask[]>(['bridge-tasks'], (prev) =>
        prev?.map((t) => (t.id === updated.id ? updated : t)),
      );
      invalidate();
    },
  }));

  const worktreeMut = createMutation(() => ({
    mutationFn: (id: string) => removeBridgeWorktree(id),
    onSuccess: invalidate,
  }));

  // Chat scroll: stick to the bottom while following a live agent, but never
  // yank the view when the user has scrolled up to read history.
  let chatEl: HTMLDivElement | undefined;
  let chatNearBottom = true;
  const onChatScroll = () => {
    if (!chatEl) return;
    chatNearBottom = chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 48;
  };
  createEffect(() => {
    const len = detail.data?.tail?.length ?? 0;
    expandedId(); // re-run when a different thread opens
    if (!chatEl || !len || !chatNearBottom) return;
    requestAnimationFrame(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    });
  });

  const [copiedResume, setCopiedResume] = createSignal<string | null>(null);
  const copyResume = async (task: BridgeTask) => {
    try {
      await navigator.clipboard.writeText(resumeCommand(task));
      setCopiedResume(task.id);
      setTimeout(() => setCopiedResume(null), 1800);
    } catch {
      /* blocked */
    }
  };

  const statusColor = (s: BridgeTask['status']) =>
    s === 'running'
      ? 'var(--color-accent)'
      : s === 'done'
        ? 'var(--color-success)'
        : s === 'stopped'
          ? 'var(--color-warn)'
          : 'var(--color-danger)';

  /** Chat-style rendering: prose bubbles for user/assistant/result (markdown),
      compact mono rows for tool calls / subagents / stderr. */
  const ChatLine = (props: { line: { kind: string; text: string } }) => {
    const k = props.line.kind;
    // Memoized render: the 1.5s poll delivers NEW objects with identical text —
    // re-assigning equal innerHTML re-parses the DOM and flickers. The memo's
    // string equality gates the assignment entirely.
    const html = createMemo(() => renderMarkdown(props.line.text));
    if (k === 'user') {
      return (
        <div class="border-accent/40 bg-accent-soft self-end rounded-lg border px-2.5 py-1.5">
          <p class="text-accent mb-0.5 text-[9.5px] font-semibold tracking-wide uppercase">You</p>
          <div
            class="lg-md text-text text-[11.5px] leading-relaxed break-words"
            innerHTML={html()}
          />
        </div>
      );
    }
    if (k === 'assistant' || k === 'result') {
      return (
        <div
          class={`bg-surface rounded-lg border px-2.5 py-1.5 ${
            k === 'result' ? 'border-success/40' : 'border-border'
          }`}
        >
          <p
            class={`mb-0.5 text-[9.5px] font-semibold tracking-wide uppercase ${
              k === 'result' ? 'text-success' : 'text-text-faint'
            }`}
          >
            {k === 'result' ? 'Result' : 'Claude'}
          </p>
          <div
            class="lg-md text-text text-[11.5px] leading-relaxed break-words"
            innerHTML={html()}
          />
        </div>
      );
    }
    return (
      <p
        class={`font-mono px-1 text-[10px] leading-relaxed break-words ${
          k === 'subagent' ? 'text-warn' : k === 'stderr' ? 'text-danger' : 'text-text-faint'
        }`}
      >
        {props.line.text}
      </p>
    );
  };

  return (
    <div class="flex h-full flex-col">
      {/* Bridge status bar */}
      <div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span class="text-text text-[12px] font-semibold">Local Claude Code</span>
        <Show when={health.data?.ok} fallback={<Badge class="text-danger">bridge offline</Badge>}>
          <Show when={versionLt(health.data!.version, '0.15.1')}>
            <Badge class="text-warn" title="Ctrl+C the old process, then: npx linear-grab-bridge">
              v{health.data!.version} outdated — restart
            </Badge>
          </Show>
          <span
            class="text-text-faint max-w-[55%] truncate text-[10.5px] tabular-nums"
            title={health.data?.cwd}
          >
            {health.data!.active} running · {health.data!.cwd.split('/').slice(-2).join('/')}
          </span>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pt-2 pb-3 pl-2 pr-3">
        <Show
          when={health.data?.ok}
          fallback={
            <EmptyState title="Bridge not running">
              Start it in your repo's terminal:
              <span class="bg-surface-2 border-border font-mono mt-2 block rounded-md border px-2 py-1.5 text-[11px] select-all">
                npx linear-grab-bridge
              </span>
              Then delegate from the Draft tab ("Local Claude Code") or watch
              tasks here. Sessions stay interactive — send follow-ups, switch
              models, interrupt, resume in your terminal. History persists
              across restarts.
            </EmptyState>
          }
        >
          <Show
            when={(tasks.data ?? []).length > 0}
            fallback={
              <EmptyState title="No local tasks yet">
                Create an issue in Draft with "Delegate to → Local Claude Code",
                and it appears here with live status and a conversation view.
              </EmptyState>
            }
          >
            <div class="flex flex-col gap-1.5">
              {/* Index (not For): tasks.data is reference-keyed and the RUNNING task's
                  object changes every poll (lastText/usage) — For rebuilt its whole
                  card each tick (flicker, model select resetting). Position-keyed
                  rows keep the DOM alive; only changed text updates. */}
              <Index each={tasks.data}>
                {(task) => (
                  <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
                    {/* Title row */}
                    <div class="flex min-w-0 items-center gap-1.5">
                      <Show
                        when={task().status === 'running'}
                        fallback={
                          <span
                            aria-hidden
                            class="size-2 shrink-0 rounded-full"
                            style={{ background: statusColor(task().status) }}
                          />
                        }
                      >
                        <Spinner />
                      </Show>
                      <span class="text-text min-w-0 truncate text-[12.5px] font-medium">
                        {task().title}
                      </span>
                      <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                        {timeAgo(task().startedAt)}
                      </span>
                    </div>

                    {/* "What is it doing now" */}
                    <p class="text-text-dim text-[11.5px] leading-snug break-words">
                      {task().lastText}
                    </p>

                    {/* Telemetry: status · model · subagents · tokens · cost */}
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Badge color={statusColor(task().status)}>{task().status}</Badge>
                      <Badge>{task().model ?? 'default model'}</Badge>
                      <Show when={task().pendingModel}>
                        <Badge class="text-warn">→ {task().pendingModel} next msg</Badge>
                      </Show>
                      <Show when={task().subagents > 0}>
                        <Badge class="text-warn">⛓ {task().subagents} subagents</Badge>
                      </Show>
                      <Show when={task().usage}>
                        <span class="text-text-faint text-[10.5px] tabular-nums">
                          ctx {fmtTokens(task().usage!.contextTokens)} · out{' '}
                          {fmtTokens(task().usage!.outputTokens)}
                          {task().usage!.costUsd ? ` · $${task().usage!.costUsd!.toFixed(2)}` : ''}
                        </span>
                      </Show>
                    </div>

                    {/* Linked Linear issue */}
                    <Show when={issueFor(task())}>
                      {(issue) => (
                        <div class="flex min-w-0 items-center gap-1.5">
                          <Badge>{issue().state.name}</Badge>
                          <ExtLink href={issue().url}>Open in Linear</ExtLink>
                        </div>
                      )}
                    </Show>

                    {/* Isolated worktree — branch, path (hover), remove when done */}
                    <Show when={task().worktree && !task().worktree!.removed}>
                      <div class="flex min-w-0 items-center gap-1.5">
                        <Badge class="text-warn">⎇ worktree</Badge>
                        <span
                          class="font-mono text-text-faint min-w-0 truncate text-[10.5px]"
                          title={task().worktree!.path}
                        >
                          {task().worktree!.branch}
                        </span>
                        <Show when={task().status !== 'running'}>
                          <Button
                            variant="ghost"
                            class="ml-auto h-6 shrink-0 px-2 text-[11px]"
                            loading={worktreeMut.isPending}
                            title={`Remove the worktree at ${task().worktree!.path} — the branch (and PR) survive`}
                            onClick={() => worktreeMut.mutate(task().id)}
                          >
                            Remove
                          </Button>
                        </Show>
                      </div>
                    </Show>

                    {/* ONE compact action row — icons with tooltips, thread below */}
                    <div class="flex items-center gap-1">
                      <Select
                        class="h-7 w-auto min-w-0 flex-1 text-[11px]"
                        value={task().pendingModel ?? task().model ?? ''}
                        onChange={(e) =>
                          modelMut.mutate({ id: task().id, model: e.currentTarget.value })
                        }
                        title="Model — applies from the next message"
                      >
                        <For each={MODEL_OPTIONS}>
                          {(m) => (
                            <option
                              value={m.id}
                              selected={(task().pendingModel ?? task().model ?? '') === m.id}
                            >
                              {m.label}
                            </option>
                          )}
                        </For>
                        {/* Sessions report full model ids (claude-fable-5) that
                            match no alias — without this the select snapped to
                            'Default model'. */}
                        <Show
                          when={
                            !MODEL_OPTIONS.some(
                              (m) => m.id === (task().pendingModel ?? task().model ?? ''),
                            )
                          }
                        >
                          <option value={task().pendingModel ?? task().model ?? ''} selected>
                            {task().pendingModel ?? task().model}
                          </option>
                        </Show>
                      </Select>
                      <Show when={task().status !== 'running' && task().sessionId}>
                        <Button
                          variant="ghost"
                          class="size-7 px-0"
                          loading={sendMut.isPending}
                          title={`Resume — continues this session${task().pendingModel ? ` on ${task().pendingModel}` : ''}`}
                          aria-label="Resume session"
                          onClick={() =>
                            sendMut.mutate({
                              id: task().id,
                              text: 'Continue where you left off. If the work is already complete, finish any remaining closeout steps (PR, Linear update, announcement).',
                            })
                          }
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                            <path d="M4.5 2.8a.8.8 0 0 1 1.22-.68l8 5.2a.8.8 0 0 1 0 1.36l-8 5.2a.8.8 0 0 1-1.22-.68V2.8Z" />
                          </svg>
                        </Button>
                      </Show>
                      <Show when={issueFor(task())}>
                        {(issue) => (
                          <Button
                            variant="ghost"
                            class="size-7 px-0"
                            title="Open the issue's Activity thread"
                            onClick={() => openPanelTo('activity', issue().id)}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden>
                              <circle cx="8" cy="8" r="6" />
                              <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
                            </svg>
                          </Button>
                        )}
                      </Show>
                      <Button
                        variant="ghost"
                        class="size-7 px-0"
                        disabled={!task().sessionId}
                        title={
                          task().sessionId
                            ? `Copy resume command · session ${task().sessionId!.slice(0, 8)}…`
                            : 'No session yet'
                        }
                        onClick={() => void copyResume(task())}
                      >
                        <Show
                          when={copiedResume() === task().id}
                          fallback={
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                              <path d="M2.5 3.5 6 7 2.5 10.5M7.5 12.5h6" />
                            </svg>
                          }
                        >
                          <span class="text-success text-[12px] leading-none">✓</span>
                        </Show>
                      </Button>
                      <Button
                        variant="ghost"
                        class="size-7 px-0"
                        title={expandedId() === task().id ? 'Hide thread' : 'Open thread — chat & changes'}
                        onClick={() => setExpandedId(expandedId() === task().id ? null : task().id)}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden>
                          <path d="M14 10a2 2 0 0 1-2 2H6l-3.5 2.5V4a2 2 0 0 1 2-2H12a2 2 0 0 1 2 2v6Z" />
                        </svg>
                      </Button>
                      <Show when={task().status === 'running'}>
                        <Button
                          variant="danger"
                          class="size-7 px-0"
                          loading={stopMut.isPending}
                          title="Interrupt — the session stays resumable"
                          onClick={() => stopMut.mutate(task().id)}
                        >
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                            <rect x="3" y="3" width="10" height="10" rx="1.5" />
                          </svg>
                        </Button>
                      </Show>
                    </div>

                    {/* Conversation + composer */}
                    <Show when={expandedId() === task().id}>
                      {/* Changes — what this task touched, like the cloud agent's card */}
                      <Show when={diff.data && (diff.data.files.length || diff.data.untracked.length || diff.data.prs.length)}>
                        <div class="border-border bg-bg flex flex-col gap-1 rounded-md border p-2">
                          <div class="flex min-w-0 items-center gap-1.5">
                            <span class="text-text-dim text-[10.5px] font-semibold tracking-wide uppercase">
                              Changes
                            </span>
                            <Show when={diff.data!.branch}>
                              <span class="font-mono text-text-faint min-w-0 truncate text-[10.5px]">
                                {diff.data!.branch}
                              </span>
                            </Show>
                            <span class="ml-auto shrink-0 text-[10.5px] tabular-nums">
                              <span class="text-success">+{diff.data!.totalAdded}</span>{' '}
                              <span class="text-danger">−{diff.data!.totalDeleted}</span>
                            </span>
                          </div>
                          <For each={diff.data!.files}>
                            {(f) => (
                              <div class="flex min-w-0 items-center gap-1.5">
                                <span class="font-mono text-text-dim min-w-0 flex-1 truncate text-[10.5px]" title={f.path}>
                                  {f.path}
                                </span>
                                <span class="shrink-0 text-[10px] tabular-nums">
                                  <Show when={!f.binary} fallback={<span class="text-text-faint">bin</span>}>
                                    <span class="text-success">+{f.added}</span>{' '}
                                    <span class="text-danger">−{f.deleted}</span>
                                  </Show>
                                </span>
                              </div>
                            )}
                          </For>
                          <For each={diff.data!.untracked}>
                            {(path) => (
                              <div class="flex min-w-0 items-center gap-1.5">
                                <span class="font-mono text-text-dim min-w-0 flex-1 truncate text-[10.5px]" title={path}>
                                  {path}
                                </span>
                                <span class="text-success shrink-0 text-[10px]">new</span>
                              </div>
                            )}
                          </For>
                          <For each={diff.data!.prs}>
                            {(pr) => (
                              <div class="flex min-w-0 items-center gap-1.5 pt-0.5">
                                <Badge class="text-accent">PR · {pr.state.toLowerCase()}</Badge>
                                <a
                                  href={pr.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  class="text-accent min-w-0 truncate text-[11px] hover:underline"
                                  title={pr.title}
                                >
                                  {pr.title}
                                </a>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                      <div
                        ref={(el) => {
                          chatEl = el;
                          chatNearBottom = true;
                        }}
                        onScroll={onChatScroll}
                        class="border-border bg-bg flex max-h-80 flex-col gap-1.5 overflow-y-auto rounded-md border py-2 pl-2 pr-3"
                      >
                        <Show
                          when={(detail.data?.tail ?? []).length > 0}
                          fallback={<p class="text-text-faint text-[11px]">Waiting for output…</p>}
                        >
                          {/* Index (not For): position-keyed, so poll refreshes
                              update rows IN PLACE instead of recreating them —
                              which was resetting the scroll to the top. */}
                          <Index each={detail.data?.tail ?? []}>
                            {(line) => <ChatLine line={line()} />}
                          </Index>
                        </Show>
                      </div>
                      <div class="flex flex-col gap-1.5">
                        <Textarea
                          rows={2}
                          placeholder={
                            task().status === 'running'
                              ? 'Message the working agent — it queues into the live session…'
                              : 'Follow-up — resumes the session…'
                          }
                          value={message()}
                          onInput={(e) => setMessage(e.currentTarget.value)}
                        />
                        <div class="flex items-center gap-1">
                          <span class="text-text-faint min-w-0 flex-1 truncate text-[10.5px]">
                            {task().alive ? 'live session' : task().sessionId ? 'resumes on send' : 'no session'}
                          </span>
                          <Button
                            variant="ghost"
                            class="size-7 shrink-0 px-0"
                            title="Pick elements on the page — refs drop into this message"
                            aria-label="Pick element"
                            onClick={pickForMessage}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                              <circle cx="8" cy="8" r="2.2" />
                              <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
                            </svg>
                          </Button>
                          <Button
                            variant="ghost"
                            class="size-7 shrink-0 px-0"
                            loading={attachBusy()}
                            title="Attach captures — element refs, screenshots, region shots, recording GIF"
                            aria-label="Attach captures"
                            onClick={() => void attachCaptures()}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                              <path d="M13 7.5 8.2 12.3a3.2 3.2 0 0 1-4.5-4.5L8.9 2.6a2.1 2.1 0 0 1 3 3L7.1 10.4a1 1 0 0 1-1.5-1.5l4.3-4.3" />
                            </svg>
                          </Button>
                          <Button
                            variant="ghost"
                            class="size-7 shrink-0 px-0"
                            disabled={!task().alive && !task().sessionId}
                            title="Compact the session — frees context (sends /compact)"
                            aria-label="Compact session"
                            onClick={() => sendMut.mutate({ id: task().id, text: '/compact' })}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                              <path d="M8 2v4M8 10v4M2 8h4M10 8h4M4.5 4.5 6 6M11.5 11.5 10 10M11.5 4.5 10 6M4.5 11.5 6 10" />
                            </svg>
                          </Button>
                          <Button
                            variant="primary"
                            class="shrink-0"
                            loading={sendMut.isPending}
                            disabled={!message().trim() || (!task().alive && !task().sessionId)}
                            onClick={() => sendMut.mutate({ id: task().id, text: message().trim() })}
                          >
                            <span class="inline-block min-w-[4ch] text-center">Send</span>
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </Index>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
