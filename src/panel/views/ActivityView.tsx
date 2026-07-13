import {
  createSignal,
  createMemo,
  createEffect,
  Show,
  For,
  type JSX,
} from 'solid-js';
import { createQuery, createMutation, useQueryClient } from '@tanstack/solid-query';
import { createVirtualizer } from '@tanstack/solid-virtual';
import type { LinearIssueSummary, LinearAgentSession, Settings } from '@/lib/types';
import { getSettings, getLastGrab } from '@/lib/storage';
import {
  fetchMyIssues,
  fetchIssueDetail,
  fetchAgentSessions,
  createSteeringComment,
  createComment,
  findAgentThreadRoots,
} from '@/lib/linear/api';
import { refreshRunningAgents } from '@/lib/agentWatch';
import { activatePicker } from '@/lib/picker';
import { buildCaptureBlock } from '@/lib/captureShare';
import { listBridgeTasks, mergePr, type BridgeTask } from '@/lib/bridge';
import { requestedIssueId, consumeNavRequest, openPanelTo, grabSink, setGrabSink } from '../nav';
import { renderMarkdown } from '../components/markdown';
import {
  Button,
  Textarea,
  Select,
  Badge,
  StateDot,
  EmptyState,
  ErrorNote,
  ExtLink,
  CloudIcon,
  MonitorIcon,
  Spinner,
  timeAgo,
} from '../components/ui';

// ---------------------------------------------------------------------------
// ActivityView
// ---------------------------------------------------------------------------

export default function ActivityView() {
  const [selectedIssueId, setSelectedIssueId] = createSignal<string | null>(null);

  // Deep-link from the launcher minimap / PRs tab.
  createEffect(() => {
    const id = requestedIssueId();
    if (id) {
      setSelectedIssueId(id);
      consumeNavRequest();
    }
  });

  return (
    <div class="flex h-full flex-col">
      <Show when={selectedIssueId() === null} fallback={
        <IssueDetailScreen
          issueId={selectedIssueId()!}
          onBack={() => setSelectedIssueId(null)}
        />
      }>
        <IssueListScreen onSelect={(id) => setSelectedIssueId(id)} />
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen A — Issue Registry
// ---------------------------------------------------------------------------

function IssueListScreen(props: { onSelect: (id: string) => void }) {
  let scrollEl!: HTMLDivElement;

  const query = createQuery<LinearIssueSummary[]>(() => ({
    queryKey: ['my-issues'],
    queryFn: fetchMyIssues,
    refetchInterval: 12_000,
  }));

  const issues = createMemo(() => query.data ?? []);

  const virtualizer = createVirtualizer({
    get count() { return issues().length; },
    getScrollElement: () => scrollEl,
    estimateSize: () => 56,
    overscan: 5,
  });

  return (
    <div class="flex h-full flex-col">
      {/* Top bar */}
      <div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span class="text-text text-[12px] font-semibold">My issues</span>
        <div class="flex items-center gap-2">
          <Show when={query.dataUpdatedAt > 0}>
            <span class="tabular-nums text-[10.5px] text-text-faint">
              live · updated {timeAgo(query.dataUpdatedAt)}
            </span>
          </Show>
          <Button
            class="size-7 px-0"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
            title="Refresh"
            aria-label="Refresh issues"
          >
            {/* Refresh icon inline */}
            <svg
              aria-hidden
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M1 4.5A7 7 0 0 1 13.5 3" />
              <path d="M15 11.5A7 7 0 0 1 2.5 13" />
              <polyline points="1 1 1 5 5 5" />
              <polyline points="15 11 15 15 11 15" />
            </svg>
          </Button>
        </div>
      </div>

      {/* Error / empty states */}
      <Show when={query.isError}>
        <div class="flex-1 overflow-y-auto">
          <EmptyState title="Connect Linear in Settings">
            {(query.error as Error)?.message ?? 'Unable to load issues.'}
          </EmptyState>
        </div>
      </Show>

      <Show when={!query.isError && !query.isPending && issues().length === 0}>
        <div class="flex-1 overflow-y-auto">
          <EmptyState title="No issues found">
            Issues you create will appear here.
          </EmptyState>
        </div>
      </Show>

      {/* Virtualised list */}
      <Show when={!query.isError && issues().length > 0}>
        <div
          ref={scrollEl!}
          class="min-h-0 flex-1 overflow-y-auto pl-2 pr-3"
        >
          <div
            style={{ position: 'relative', height: `${virtualizer.getTotalSize()}px` }}
          >
            <For each={virtualizer.getVirtualItems()}>
              {(vRow) => {
                const issue = createMemo(() => issues()[vRow.index]);
                return (
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vRow.start}px)`,
                    }}
                  >
                    <IssueRow issue={issue()} onSelect={props.onSelect} />
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function IssueRow(props: { issue: LinearIssueSummary; onSelect: (id: string) => void }) {
  return (
    <button
      class="w-full cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-surface-2 transition-colors"
      onClick={() => props.onSelect(props.issue.id)}
    >
      {/* Line 1: dot + identifier + title */}
      <div class="flex items-center gap-1.5 min-w-0">
        <StateDot color={props.issue.state.color} />
        <span class="font-mono text-[11px] text-text-dim shrink-0">
          {props.issue.identifier}
        </span>
        <span class="truncate text-[12.5px] text-text">
          {props.issue.title}
        </span>
      </div>
      {/* Line 2: state badge, delegate badge, timestamp */}
      <div class="mt-0.5 flex items-center gap-1.5">
        <Badge>{props.issue.state.name}</Badge>
        <Show when={props.issue.delegate}>
          <Badge class="text-accent"><CloudIcon /> {props.issue.delegate!.displayName}</Badge>
        </Show>
        {/* Agent finished (PR linked) but the issue is still open — your turn. */}
        <Show
          when={
            props.issue.state.type === 'started' &&
            props.issue.delegate &&
            props.issue.attachments?.some((a) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(a.url))
          }
        >
          <Badge color="var(--color-warn)">needs review</Badge>
        </Show>
        <span class="ml-auto tabular-nums text-[10.5px] text-text-faint">
          {timeAgo(props.issue.updatedAt)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Screen B — Issue Detail
// ---------------------------------------------------------------------------

function IssueDetailScreen(props: { issueId: string; onBack: () => void }) {
  const queryClient = useQueryClient();

  const detailQuery = createQuery(() => ({
    queryKey: ['issue', props.issueId],
    queryFn: () => fetchIssueDetail(props.issueId),
    refetchInterval: 8_000,
    enabled: !!props.issueId,
  }));

  const sessionsQuery = createQuery<LinearAgentSession[]>(() => ({
    queryKey: ['sessions', props.issueId],
    queryFn: () => fetchAgentSessions(props.issueId),
    refetchInterval: 8_000,
    enabled: !!props.issueId,
  }));

  const settingsQuery = createQuery<Settings>(() => ({
    queryKey: ['settings'],
    queryFn: getSettings,
  }));

  // Live LOCAL session for this issue — the bridge twin of Linear's Cursor
  // session cards. Hidden when the bridge is offline or no task matches.
  const bridgeTasks = createQuery(() => ({
    queryKey: ['bridge-tasks'],
    queryFn: listBridgeTasks,
    refetchInterval: 5_000,
    retry: 0,
  }));
  const localTask = createMemo<BridgeTask | undefined>(() => {
    const identifier = detailQuery.data?.identifier;
    return identifier
      ? bridgeTasks.data?.find((t) => t.title.startsWith(identifier))
      : undefined;
  });
  const localStatus = (t: BridgeTask) =>
    t.status === 'running'
      ? { word: 'Working…', cls: 'text-accent' }
      : t.status === 'done'
        ? { word: 'Finished', cls: 'text-success' }
        : t.status === 'stopped'
          ? { word: 'Stopped', cls: 'text-warn' }
          : { word: 'Error', cls: 'text-danger' };

  const [body, setBody] = createSignal('');
  const [sendError, setSendError] = createSignal<string | null>(null);

  // Composer element-picking: point at page elements and their source refs
  // append to the reply — 'fix these too' steering with exact pointers.
  const [pickStartedAt, setPickStartedAt] = createSignal(0);
  const grabQuery = createQuery(() => ({
    queryKey: ['grab'],
    queryFn: getLastGrab,
    enabled: grabSink() === 'composer',
  }));
  const [attachBusy, setAttachBusy] = createSignal(false);
  const attachCaptures = async () => {
    setAttachBusy(true);
    try {
      const block = await buildCaptureBlock();
      if (block) setBody((prev) => `${prev ? `${prev}\n` : ''}${block}\n`);
    } finally {
      setAttachBusy(false);
    }
  };

  const pickForReply = () => {
    setPickStartedAt(Date.now());
    setGrabSink('composer');
    void activatePicker().catch(() => setGrabSink('capture'));
  };
  createEffect(() => {
    if (grabSink() !== 'composer') return;
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
    setBody((prev) => `${prev ? `${prev}\n` : ''}${refs}\n`);
    setGrabSink('capture');
  });

  // Fast-merge: reviewed the demo → one click ships the PR (bridge gh).
  const [mergeBusy, setMergeBusy] = createSignal<string | null>(null);
  const [mergedUrls, setMergedUrls] = createSignal<Set<string>>(new Set());
  const [mergeError, setMergeError] = createSignal<string | null>(null);
  const doMerge = async (url: string) => {
    setMergeError(null);
    setMergeBusy(url);
    try {
      await mergePr(url);
      setMergedUrls((prev) => new Set(prev).add(url));
      void queryClient.invalidateQueries({ queryKey: ['issue', props.issueId] });
      void queryClient.invalidateQueries({ queryKey: ['my-issues'] });
      refreshRunningAgents();
    } catch (err) {
      setMergeError(
        err instanceof Error
          ? `${err.message} (bridge must be running; gh needs merge rights)`
          : 'Merge failed.',
      );
    } finally {
      setMergeBusy(null);
    }
  };

  /**
   * Reply targets. THE critical distinction: a top-level @Cursor comment spawns
   * a NEW cloud agent; replying INSIDE an agent session's comment thread
   * (parentId = thread root) steers the agent already running there.
   */
  const agentThreads = createMemo(() =>
    detailQuery.data ? findAgentThreadRoots(detailQuery.data.comments) : [],
  );

  const [target, setTarget] = createSignal<string>('comment');
  // Default once data is in: steer the newest agent thread when one exists.
  let targetInitialised = false;
  createEffect(() => {
    if (targetInitialised || !detailQuery.data || !settingsQuery.data) return;
    targetInitialised = true;
    const threads = agentThreads();
    if (threads.length) setTarget(`thread:${threads[0].id}`);
    else if (detailQuery.data.delegate && settingsQuery.data.cursorAgentId) setTarget('new');
  });

  const sendMutation = createMutation(() => ({
    mutationFn: async () => {
      const text = body().trim();
      if (!text) throw new Error('Message is empty');
      const settings = settingsQuery.data ?? {};
      const t = target();
      if (t.startsWith('thread:')) {
        // In-thread reply — reaches the RUNNING agent, no mention needed.
        await createComment(props.issueId, text, t.slice('thread:'.length));
      } else if (t === 'new' && settings.cursorAgentId) {
        await createSteeringComment(props.issueId, text, {
          name: settings.cursorAgentName,
          displayName: settings.cursorAgentName ?? 'Cursor',
          url: settings.cursorAgentUrl,
        });
      } else {
        await createComment(props.issueId, text);
      }
    },
    onSuccess: () => {
      setBody('');
      setSendError(null);
      void queryClient.invalidateQueries({ queryKey: ['issue', props.issueId] });
      refreshRunningAgents();
    },
    onError: (err: Error) => {
      setSendError(err.message ?? 'Failed to send');
    },
  }));

  const issue = createMemo(() => detailQuery.data);
  const sessions = createMemo(() => sessionsQuery.data ?? []);

  return (
    <div class="flex h-full flex-col">
      {/* Header */}
      <div class="border-border flex shrink-0 flex-col gap-1 border-b px-3 py-2">
        <div class="flex items-center gap-2">
          <Button
            class="min-w-[68px] shrink-0 text-[11px]"
            onClick={props.onBack}
          >
            <span class="inline-block min-w-[6ch] text-left">← Back</span>
          </Button>
          <Show when={issue()}>
            <span class="font-mono text-[11px] text-text-dim shrink-0">
              {issue()!.identifier}
            </span>
            <span class="truncate text-[12px] font-medium text-text">
              {issue()!.title}
            </span>
          </Show>
          <Show when={detailQuery.isPending && !issue()}>
            <span class="text-[11.5px] text-text-faint">Loading…</span>
          </Show>
        </div>
        <Show when={issue()}>
          <div class="flex items-center gap-2">
            <StateDot color={issue()!.state.color} />
            <span class="text-[11px] text-text-dim">{issue()!.state.name}</span>
            <ExtLink href={issue()!.url} class="ml-auto shrink-0">
              Open in Linear
            </ExtLink>
          </div>
        </Show>
      </div>

      {/* Scrollable body */}
      <div class="min-h-0 flex-1 overflow-y-auto pl-3 pr-4 py-3 flex flex-col gap-3">
        {/* LOCAL Claude Code session — live card, like Linear's Cursor cards */}
        <Show when={localTask()}>
          {(t) => {
            const st = () => localStatus(t());
            return (
              <div class="bg-surface border-border overflow-clip rounded-lg border">
                <div class="border-border flex h-9 min-w-0 items-center justify-between gap-2 border-b px-3">
                  <div class="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium">
                    <span aria-hidden class="text-text-dim inline-flex"><MonitorIcon size={12} /></span>
                    <span class="text-text shrink-0">Local Claude Code</span>
                    <span class="text-text-dim shrink-0">started by you</span>
                    <span class="text-text-faint shrink-0 tabular-nums">
                      · {timeAgo(t().startedAt)}
                    </span>
                  </div>
                  <Badge>{t().model ?? 'default'}</Badge>
                </div>
                <button
                  class="hover:bg-surface-2 flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 px-3 text-left transition-colors"
                  title="Open the live thread in the Local tab"
                  onClick={() => openPanelTo('local')}
                >
                  <Show when={t().status === 'running'}>
                    <Spinner size={12} />
                  </Show>
                  <span class={`shrink-0 text-[11.5px] font-medium ${st().cls}`}>
                    {st().word}
                  </span>
                  <span class="text-text-faint min-w-0 flex-1 truncate text-[11.5px]">
                    {t().status === 'done' ? (t().result ?? t().lastText) : t().lastText}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden class="text-text-dim shrink-0">
                    <path d="m6 3.5 4.5 4.5L6 12.5" />
                  </svg>
                </button>
              </div>
            );
          }}
        </Show>

        {/* Agent sessions */}
        <Show when={sessions().length > 0}>
          <div class="flex flex-col gap-2">
            <For each={sessions()}>
              {(session) => <AgentSessionCard session={session} />}
            </For>
          </div>
        </Show>

        {/* Attachments */}
        <Show when={issue() && issue()!.attachments.length > 0}>
          <div class="flex flex-col gap-1">
            <span class="text-[10.5px] font-semibold uppercase tracking-wide text-text-dim">
              Attachments
            </span>
            <div class="flex flex-col gap-1">
              <For each={issue()!.attachments}>
                {(att) => {
                  const isPr = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(att.url);
                  return (
                    <div class="flex min-w-0 items-center gap-1.5">
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noreferrer"
                        class="text-accent min-w-0 truncate text-[11.5px] hover:underline"
                        title={att.title}
                      >
                        {att.title}
                      </a>
                      <Show when={isPr}>
                        <Button
                          variant="primary"
                          class="ml-auto h-6 shrink-0 px-2 text-[11px]"
                          loading={mergeBusy() === att.url}
                          disabled={mergedUrls().has(att.url)}
                          title="Squash-merge this PR via the bridge's gh — reviewed the demo? Ship it."
                          onClick={() => void doMerge(att.url)}
                        >
                          <span class="inline-block min-w-[6ch] text-center">
                            {mergedUrls().has(att.url) ? 'Merged ✓' : 'Merge'}
                          </span>
                        </Button>
                      </Show>
                    </div>
                  );
                }}
              </For>
              <Show when={mergeError()}>
                <ErrorNote message={mergeError()!} />
              </Show>
            </div>
          </div>
        </Show>

        {/* Comments */}
        <Show when={issue() && issue()!.comments.length > 0}>
          <div class="flex flex-col gap-2.5">
            <span class="text-[10.5px] font-semibold uppercase tracking-wide text-text-dim">
              Comments
            </span>
            <For each={issue()!.comments}>
              {(comment) => (
                <div class="flex flex-col gap-0.5">
                  <div class="flex items-center gap-1.5">
                    <span class="text-[11px] font-medium text-text-dim">
                      {comment.user?.displayName ?? comment.user?.name ?? 'Unknown'}
                    </span>
                    <Show when={comment.user?.app}>
                      <Badge>agent</Badge>
                    </Show>
                    <span class="ml-auto tabular-nums text-[10.5px] text-text-faint">
                      {timeAgo(comment.createdAt)}
                    </span>
                  </div>
                  <div
                    class="lg-md text-text text-[12px] leading-relaxed break-words"
                    innerHTML={renderMarkdown(comment.body)}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Empty state */}
        <Show when={issue() && issue()!.comments.length === 0 && sessions().length === 0}>
          <EmptyState title="No activity yet">
            Comments and agent sessions will appear here.
          </EmptyState>
        </Show>

        {/* Detail error */}
        <Show when={detailQuery.isError && !issue()}>
          <EmptyState title="Failed to load issue">
            {(detailQuery.error as Error)?.message ?? 'Unknown error'}
          </EmptyState>
        </Show>
      </div>

      {/* Composer */}
      <div class="border-border shrink-0 border-t p-2.5 flex flex-col gap-1.5">
        <Show when={sendError()}>
          <ErrorNote message={sendError()!} />
        </Show>
        <Textarea
          rows={2}
          placeholder="Reply — steer the agent or add context…"
          value={body()}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          disabled={sendMutation.isPending}
        />
        <div class="flex items-center gap-2">
          {/* Reply target — steering a running agent vs spawning a new one is a
              real, costly difference; make it an explicit visible choice. */}
          <Select
            class="min-w-0 flex-1"
            value={target()}
            onChange={(e) => setTarget(e.currentTarget.value)}
          >
            <For each={agentThreads()}>
              {(thread, i) => (
                <option value={`thread:${thread.id}`} selected={target() === `thread:${thread.id}`}>
                  Steer running agent{agentThreads().length > 1 ? ` #${i() + 1}` : ''} · {timeAgo(thread.createdAt)}
                </option>
              )}
            </For>
            <Show when={settingsQuery.data?.cursorAgentId}>
              <option value="new" selected={target() === 'new'}>
                Start NEW agent (@{settingsQuery.data?.cursorAgentName ?? 'Cursor'})
              </option>
            </Show>
            <option value="comment" selected={target() === 'comment'}>
              Comment only
            </option>
          </Select>
          <Button
            variant="ghost"
            class="size-7 shrink-0 px-0"
            title="Pick elements on the page — their source refs drop into this reply"
            aria-label="Pick element for reply"
            onClick={pickForReply}
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
            class="min-w-[52px] shrink-0"
            variant="primary"
            loading={sendMutation.isPending}
            disabled={body().trim().length === 0}
            onClick={() => sendMutation.mutate()}
          >
            <span class="inline-block min-w-[4ch] text-left">Send</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Session Card
// ---------------------------------------------------------------------------

function AgentSessionCard(props: { session: LinearAgentSession }) {
  // Inline style via Badge's `color` prop — a competing text-* class would race
  // Badge's own text-text-dim in stylesheet order.
  const statusColor = createMemo(() => {
    const s = props.session.status;
    if (/complete|done/i.test(s)) return 'var(--color-success)';
    if (/await|pending|elicit/i.test(s)) return 'var(--color-warn)';
    return 'var(--color-accent)';
  });

  // Last ~10 activities
  const recentActivities = createMemo(() =>
    props.session.activities.slice(-10),
  );

  return (
    <div class="bg-surface border-border rounded-lg border p-2.5 flex flex-col gap-1.5">
      {/* Session header */}
      <div class="flex items-center gap-1.5 flex-wrap">
        <Badge color={statusColor()}>{props.session.status}</Badge>
        <Show when={props.session.appUser?.displayName}>
          <span class="text-[11px] text-text-dim">
            {props.session.appUser!.displayName}
          </span>
        </Show>
        <span class="ml-auto tabular-nums text-[10.5px] text-text-faint">
          {timeAgo(props.session.updatedAt)}
        </span>
      </div>

      {/* Summary */}
      <Show when={props.session.summary}>
        <p class="text-[12px] text-text leading-relaxed whitespace-pre-wrap break-words">
          {props.session.summary}
        </p>
      </Show>

      {/* Activity timeline */}
      <Show when={recentActivities().length > 0}>
        <div class="flex flex-col gap-0.5 border-t border-border pt-1.5 mt-0.5">
          <For each={recentActivities()}>
            {(activity) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const content = activity.content as any;
              const text = String(
                content?.body ?? content?.text ?? content?.type ?? JSON.stringify(content),
              ).slice(0, 300);
              return (
                <div class="flex items-start gap-1.5">
                  <span class="tabular-nums text-[10px] text-text-faint shrink-0 mt-px">
                    {timeAgo(activity.createdAt)}
                  </span>
                  <span class="text-[11px] text-text-dim break-words min-w-0">
                    {text}
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
