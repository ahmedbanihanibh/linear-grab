import { createSignal, For, Show } from 'solid-js';
import { createQuery, createMutation, useQueryClient } from '@tanstack/solid-query';
import {
  fetchBridgeHealth,
  fetchBridgeTask,
  listBridgeTasks,
  sendBridgeMessage,
  setBridgeModel,
  stopBridgeTask,
  resumeCommand,
  type BridgeTask,
} from '@/lib/bridge';
import { fetchMyIssues } from '@/lib/linear/api';
import { openPanelTo } from '../nav';
import { Button, Badge, EmptyState, Select, Spinner, Textarea, timeAgo } from '../components/ui';
import { renderMarkdown } from '../components/markdown';

const MODEL_OPTIONS = [
  { id: '', label: 'Default model' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['bridge-tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['bridge-task', expandedId()] });
  };

  const stopMut = createMutation(() => ({
    mutationFn: (id: string) => stopBridgeTask(id),
    onSuccess: invalidate,
  }));

  const [message, setMessage] = createSignal('');
  const sendMut = createMutation(() => ({
    mutationFn: (args: { id: string; text: string }) => sendBridgeMessage(args.id, args.text),
    onSuccess: () => {
      setMessage('');
      invalidate();
    },
  }));

  const modelMut = createMutation(() => ({
    mutationFn: (args: { id: string; model: string }) => setBridgeModel(args.id, args.model),
    onSuccess: invalidate,
  }));

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
    if (k === 'user') {
      return (
        <div class="border-accent/40 bg-accent-soft self-end rounded-lg border px-2.5 py-1.5">
          <p class="text-accent mb-0.5 text-[9.5px] font-semibold tracking-wide uppercase">You</p>
          <div
            class="lg-md text-text text-[11.5px] leading-relaxed break-words"
            innerHTML={renderMarkdown(props.line.text)}
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
            innerHTML={renderMarkdown(props.line.text)}
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
              <For each={tasks.data}>
                {(task) => (
                  <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
                    {/* Title row */}
                    <div class="flex min-w-0 items-center gap-1.5">
                      <Show
                        when={task.status === 'running'}
                        fallback={
                          <span
                            aria-hidden
                            class="size-2 shrink-0 rounded-full"
                            style={{ background: statusColor(task.status) }}
                          />
                        }
                      >
                        <Spinner />
                      </Show>
                      <span class="text-text min-w-0 truncate text-[12.5px] font-medium">
                        {task.title}
                      </span>
                      <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                        {timeAgo(task.startedAt)}
                      </span>
                    </div>

                    {/* "What is it doing now" */}
                    <p class="text-text-dim text-[11.5px] leading-snug break-words">
                      {task.lastText}
                    </p>

                    {/* Telemetry: status · model · subagents · tokens · cost */}
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Badge color={statusColor(task.status)}>{task.status}</Badge>
                      <Show when={task.model}>
                        <Badge>{task.model}</Badge>
                      </Show>
                      <Show when={task.pendingModel}>
                        <Badge class="text-warn">→ {task.pendingModel} next msg</Badge>
                      </Show>
                      <Show when={task.subagents > 0}>
                        <Badge class="text-warn">⛓ {task.subagents} subagents</Badge>
                      </Show>
                      <Show when={task.usage}>
                        <span class="text-text-faint text-[10.5px] tabular-nums">
                          ctx {fmtTokens(task.usage!.contextTokens)} · out{' '}
                          {fmtTokens(task.usage!.outputTokens)}
                          {task.usage!.costUsd ? ` · $${task.usage!.costUsd.toFixed(2)}` : ''}
                        </span>
                      </Show>
                    </div>

                    {/* Linked Linear issue */}
                    <Show when={issueFor(task)}>
                      {(issue) => (
                        <div class="flex items-center gap-1.5">
                          <Badge>{issue().state.name}</Badge>
                          <a
                            href={issue().url}
                            target="_blank"
                            rel="noreferrer"
                            class="text-accent text-[11px] hover:underline"
                          >
                            Open in Linear ↗
                          </a>
                          <Button
                            variant="ghost"
                            class="ml-auto h-6 px-2 text-[11px]"
                            title="Open the issue's Activity thread"
                            onClick={() => openPanelTo('activity', issue().id)}
                          >
                            Issue
                          </Button>
                        </div>
                      )}
                    </Show>

                    {/* Session id + resume */}
                    <Show when={task.sessionId}>
                      <div class="flex min-w-0 items-center gap-1.5">
                        <span class="font-mono text-text-faint min-w-0 truncate text-[10.5px]">
                          session {task.sessionId}
                        </span>
                        <Button
                          variant="ghost"
                          class="ml-auto h-6 shrink-0 px-2 text-[11px]"
                          title={`Copy: ${resumeCommand(task)}`}
                          onClick={() => void copyResume(task)}
                        >
                          <span class="inline-block min-w-[9ch] text-center">
                            {copiedResume() === task.id ? 'Copied ✓' : 'Copy resume'}
                          </span>
                        </Button>
                      </div>
                    </Show>

                    {/* Actions */}
                    <div class="flex items-center gap-1.5">
                      <Select
                        class="h-6 w-auto min-w-0 flex-1 text-[11px]"
                        value={task.pendingModel ?? task.model ?? ''}
                        onChange={(e) =>
                          modelMut.mutate({ id: task.id, model: e.currentTarget.value })
                        }
                        title="Model — applies from the next message (never kills the current turn)"
                      >
                        <For each={MODEL_OPTIONS}>
                          {(m) => (
                            <option
                              value={m.id}
                              selected={(task.pendingModel ?? task.model ?? '') === m.id}
                            >
                              {m.label}
                            </option>
                          )}
                        </For>
                      </Select>
                      <Button
                        variant="ghost"
                        class="h-6 px-2 text-[11px]"
                        onClick={() => setExpandedId(expandedId() === task.id ? null : task.id)}
                      >
                        <span class="inline-block min-w-[4ch] text-center">
                          {expandedId() === task.id ? 'Hide' : 'Chat'}
                        </span>
                      </Button>
                      <Show when={task.status === 'running'}>
                        <Button
                          variant="danger"
                          class="h-6 px-2 text-[11px]"
                          loading={stopMut.isPending}
                          title="Interrupt — the session stays resumable"
                          onClick={() => stopMut.mutate(task.id)}
                        >
                          Interrupt
                        </Button>
                      </Show>
                    </div>

                    {/* Conversation + composer */}
                    <Show when={expandedId() === task.id}>
                      <div class="border-border bg-bg flex max-h-80 flex-col gap-1.5 overflow-y-auto rounded-md border py-2 pl-2 pr-3">
                        <Show
                          when={(detail.data?.tail ?? []).length > 0}
                          fallback={<p class="text-text-faint text-[11px]">Waiting for output…</p>}
                        >
                          <For each={detail.data!.tail}>{(line) => <ChatLine line={line} />}</For>
                        </Show>
                      </div>
                      <div class="flex flex-col gap-1.5">
                        <Textarea
                          rows={2}
                          placeholder={
                            task.status === 'running'
                              ? 'Message the working agent — it queues into the live session…'
                              : 'Follow-up — resumes the session…'
                          }
                          value={message()}
                          onInput={(e) => setMessage(e.currentTarget.value)}
                        />
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-text-faint min-w-0 truncate text-[10.5px]">
                            {task.alive ? 'live session' : task.sessionId ? 'resumes on send' : 'no session'}
                          </span>
                          <Button
                            variant="primary"
                            class="shrink-0"
                            loading={sendMut.isPending}
                            disabled={!message().trim() || (!task.alive && !task.sessionId)}
                            onClick={() => sendMut.mutate({ id: task.id, text: message().trim() })}
                          >
                            <span class="inline-block min-w-[4ch] text-center">Send</span>
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
