import {
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  Show,
  For,
  Index,
  type JSX,
} from 'solid-js';
import { persistentSignal } from '../persist';
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
import {
  getRecorderSnapshot,
  subscribeRecorder,
  startRecording,
  stopRecording,
} from '@/lib/recorder';
import { buildCaptureBlock } from '@/lib/captureShare';
import { fetchPrStatuses, listBridgeTasks, mergePr, resumeCommand, sendBridgeMessage, setBridgeModel, stopBridgeTask, type BridgeTask } from '@/lib/bridge';
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
  Input,
} from '../components/ui';

/** Memoized markdown body — equal innerHTML re-assignment re-parses the DOM
    (the comment flicker on every poll). The memo gates it entirely. */
function CommentBody(props: { text: string }) {
  const html = createMemo(() => renderMarkdown(props.text));
  return (
    <div class="lg-md text-text text-[12px] leading-relaxed break-words" innerHTML={html()} />
  );
}

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

  // Local delegations carry no Linear delegate — the bridge task list is the
  // only truth for the 'local' executor tag.
  const listBridge = createQuery(() => ({
    queryKey: ['bridge-tasks'],
    queryFn: listBridgeTasks,
    refetchInterval: 10_000,
    retry: 0,
  }));
  const isLocal = (i: LinearIssueSummary) =>
    (listBridge.data ?? []).some((t) => t.title.startsWith(i.identifier));
  const needsReview = (i: LinearIssueSummary) =>
    i.state.type === 'started' &&
    i.attachments?.some((a) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(a.url));

  type ListFilter = 'all' | 'active' | 'review' | 'done' | 'cloud' | 'local';
  const FILTERS: Array<{ id: ListFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'In Progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'local', label: 'Local' },
  ];
  const [filter, setFilter] = persistentSignal<ListFilter>('issues:filter', 'all');
  const [term, setTerm] = persistentSignal('issues:search', '');

  const issues = createMemo(() => {
    const t = term().trim().toLowerCase();
    return (query.data ?? []).filter((i) => {
      if (t && !`${i.identifier} ${i.title}`.toLowerCase().includes(t)) return false;
      switch (filter()) {
        case 'active':
          return i.state.type === 'started';
        case 'review':
          return !!needsReview(i);
        case 'done':
          return i.state.type === 'completed';
        case 'cloud':
          return !!i.delegate;
        case 'local':
          return isLocal(i);
        default:
          return true;
      }
    });
  });

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

      {/* Filters — same pattern as the PRs tab */}
      <div class="border-border flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        <For each={FILTERS}>
          {(f) => (
            <button
              class={`h-6 shrink-0 cursor-pointer rounded-md px-2 text-[11px] font-medium transition-colors ${
                filter() === f.id
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-dim hover:bg-surface-2'
              }`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          )}
        </For>
        <Input
          class="ml-auto h-6 w-28 text-[11px]"
          placeholder="Search…"
          value={term()}
          onInput={(e) => setTerm(e.currentTarget.value)}
        />
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
                  // Filter changes shrink the list before the virtualizer
                  // recomputes — stale indexes yield undefined; render nothing.
                  <Show when={issue()}>
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vRow.start}px)`,
                      }}
                    >
                      <IssueRow issue={issue()} local={isLocal(issue())} onSelect={props.onSelect} />
                    </div>
                  </Show>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function IssueRow(props: {
  issue: LinearIssueSummary;
  local?: boolean;
  onSelect: (id: string) => void;
}) {
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
        <Show when={props.local}>
          <Badge class="text-accent"><MonitorIcon /> local</Badge>
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

export function IssueDetailScreen(props: { issueId: string; onBack: () => void }) {
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
  const LOCAL_MODELS = [
    { id: '', label: 'Default model' },
    { id: 'fable', label: 'Fable 5' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ];
  const localModelMut = createMutation(() => ({
    mutationFn: (args: { id: string; model: string }) => setBridgeModel(args.id, args.model),
    onSuccess: (updated) => {
      queryClient.setQueryData<BridgeTask[]>(['bridge-tasks'], (prev) =>
        prev?.map((bt) => (bt.id === updated.id ? updated : bt)),
      );
    },
  }));

  const localResumeMut = createMutation(() => ({
    mutationFn: (id: string) =>
      sendBridgeMessage(
        id,
        'Continue where you left off. If the work is already complete, finish any remaining closeout steps (PR, Linear update, announcement).',
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bridge-tasks'] }),
  }));
  const localStopMut = createMutation(() => ({
    mutationFn: (id: string) => stopBridgeTask(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bridge-tasks'] }),
  }));
  const [copiedResume, setCopiedResume] = createSignal(false);
  const copyLocalResume = async (task: BridgeTask) => {
    try {
      await navigator.clipboard.writeText(resumeCommand(task));
      setCopiedResume(true);
      setTimeout(() => setCopiedResume(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

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

  // eslint-disable-next-line solid/reactivity -- key fixed per mount; the screen remounts per issue
  const [body, setBody] = persistentSignal(`activity-reply:${props.issueId}`, '');
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
    setSendError(null);
    try {
      const block = await buildCaptureBlock();
      if (block) setBody((prev) => `${prev ? `${prev}\n` : ''}${block}\n`);
      else setSendError('Nothing captured yet — pick an element, capture a region, or record first.');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Attach failed.');
    } finally {
      setAttachBusy(false);
    }
  };

  // STICKY pick mode: toggles on/off — every pick (incl. react-grab's native
  // hotkey flow) appends here until you toggle off or send. No more bouncing
  // to Capture on pick #2.
  const pickForReply = () => {
    if (grabSink() === 'composer') {
      setGrabSink('capture');
      return;
    }
    setPickStartedAt(Date.now());
    setGrabSink('composer');
    void activatePicker().catch(() => setGrabSink('capture'));
  };
  createEffect(() => {
    if (grabSink() !== 'composer') return;
    const fresh = (grabQuery.data ?? []).filter((g) => g.grabbedAt > pickStartedAt());
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
    setPickStartedAt(Math.max(...fresh.map((g) => g.grabbedAt))); // stay in pick mode
  });

  // Record a GIF straight from the thread; auto-attach when it's ready.
  const [recSnap, setRecSnap] = createSignal(getRecorderSnapshot());
  onCleanup(subscribeRecorder(setRecSnap));
  let recInitiatedHere = false;
  createEffect(() => {
    if (recSnap().phase === 'ready' && recInitiatedHere) {
      recInitiatedHere = false;
      void attachCaptures();
    }
  });
  const toggleRecord = () => {
    if (recSnap().phase === 'recording') {
      void stopRecording();
    } else {
      recInitiatedHere = true;
      void startRecording();
    }
  };

  // Real PR states for the attachment rows (gh via bridge).
  const PR_RX = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;
  const prUrls = createMemo(() =>
    (detailQuery.data?.attachments ?? []).map((a) => a.url).filter((u) => PR_RX.test(u)),
  );
  const prStatuses = createQuery(() => ({
    queryKey: ['pr-status', prUrls().sort().join('|')],
    queryFn: () => fetchPrStatuses(prUrls()),
    refetchInterval: 30_000,
    retry: 0,
    enabled: prUrls().length > 0,
  }));
  const prState = (url: string) =>
    mergedUrls().has(url) ? 'MERGED' : prStatuses.data?.statuses[url];

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
  const agentThreads = createMemo(() => {
    const fromComments = detailQuery.data ? findAgentThreadRoots(detailQuery.data.comments) : [];
    // AgentSession.comment is the AUTHORITATIVE thread root — the comment
    // heuristic misses placeholder-bodied roots ('This thread is for an agent
    // session…' by an author it can't classify), which left running agents
    // unsteerable. Merge both, sessions first.
    const seen = new Set(fromComments.map((c) => c.id));
    const fromSessions = (sessionsQuery.data ?? [])
      .filter((sn) => sn.comment?.id && !seen.has(sn.comment.id))
      .map((sn) => ({
        id: sn.comment!.id,
        createdAt: sn.updatedAt,
        body: '',
        user: { displayName: sn.appUser?.displayName ?? 'agent', app: true },
        parent: null,
      }));
    return [...fromSessions, ...fromComments];
  });

  const [target, setTarget] = createSignal<string>('comment');
  let userSetTarget = false;
  // Default once data is in: steer the newest agent thread when one exists.
  let targetInitialised = false;
  createEffect(() => {
    if (targetInitialised || !detailQuery.data || !settingsQuery.data) return;
    targetInitialised = true;
    const threads = agentThreads();
    if (threads.length) setTarget(`thread:${threads[0].id}`);
    else if (detailQuery.data.delegate && settingsQuery.data.cursorAgentId) setTarget('new');
  });
  // Upgrade to the local session once the bridge task is known (unless the
  // user already chose a target themselves).
  createEffect(() => {
    if (userSetTarget) return;
    if (localTask() && (target() === 'comment' || target() === 'new')) setTarget('local');
  });
  // Sessions load after comments — when a steerable thread appears late,
  // upgrade from the spawn-new default (steering ≠ spawning a 2nd agent).
  createEffect(() => {
    if (userSetTarget) return;
    const threads = agentThreads();
    if (threads.length && (target() === 'comment' || target() === 'new'))
      setTarget(`thread:${threads[0].id}`);
  });

  const sendMutation = createMutation(() => ({
    mutationFn: async () => {
      const text = body().trim();
      if (!text) throw new Error('Message is empty');
      const settings = settingsQuery.data ?? {};
      const t = target();
      if (t === 'local') {
        const task = localTask();
        if (!task) throw new Error('Local session not found — is the bridge running?');
        await sendBridgeMessage(task.id, text);
        // Mirror into the Linear thread so the issue stays the full record.
        await createComment(props.issueId, `🖥️ **→ local agent:** ${text}`).catch(() => {});
      } else if (t.startsWith('thread:')) {
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
      setGrabSink('capture'); // end sticky pick mode with the sent message
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
            variant="ghost"
            class="size-7 shrink-0 px-0"
            title="Back to issues"
            aria-label="Back to issues"
            onClick={props.onBack}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
              <path d="M10.5 3.5 6 8l4.5 4.5" />
            </svg>
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
                  {/* Same model control as the Local tab — applies from the
                      next message (a live turn is never killed mid-run). */}
                  <Select
                    class="h-6 w-auto max-w-[110px] shrink-0 text-[10.5px]"
                    value={t().pendingModel ?? t().model ?? ''}
                    onChange={(e) =>
                      localModelMut.mutate({ id: t().id, model: e.currentTarget.value })
                    }
                    title="Model — applies from the next message"
                  >
                    <For each={LOCAL_MODELS}>
                      {(m) => (
                        <option
                          value={m.id}
                          selected={(t().pendingModel ?? t().model ?? '') === m.id}
                        >
                          {m.label}
                        </option>
                      )}
                    </For>
                    <Show
                      when={
                        !LOCAL_MODELS.some((m) => m.id === (t().pendingModel ?? t().model ?? ''))
                      }
                    >
                      <option value={t().pendingModel ?? t().model ?? ''} selected>
                        {t().pendingModel ?? t().model}
                      </option>
                    </Show>
                  </Select>
                </div>
                <div class="flex h-9 items-center gap-1 pr-2">
                  <button
                    class="hover:bg-surface-2 flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-3 text-left transition-colors"
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
                  {/* Session controls — same set as the Local tab card */}
                  <Show when={t().status === 'running'}>
                    <Button
                      variant="danger"
                      class="size-6 shrink-0 px-0"
                      loading={localStopMut.isPending}
                      title="Stop the session — resumable afterwards"
                      aria-label="Stop session"
                      onClick={() => localStopMut.mutate(t().id)}
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                        <rect x="3" y="3" width="10" height="10" rx="1.5" />
                      </svg>
                    </Button>
                  </Show>
                  <Show when={t().status !== 'running' && t().sessionId}>
                    <Button
                      variant="ghost"
                      class="size-6 shrink-0 px-0"
                      loading={localResumeMut.isPending}
                      title={`Run again — resumes this session${t().pendingModel ? ` on ${t().pendingModel}` : ''}`}
                      aria-label="Resume session"
                      onClick={() => localResumeMut.mutate(t().id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                        <path d="M4.5 2.8a.8.8 0 0 1 1.22-.68l8 5.2a.8.8 0 0 1 0 1.36l-8 5.2a.8.8 0 0 1-1.22-.68V2.8Z" />
                      </svg>
                    </Button>
                  </Show>
                  <Show when={t().sessionId}>
                    <Button
                      variant="ghost"
                      class="size-6 shrink-0 px-0"
                      title={
                        copiedResume()
                          ? 'Copied!'
                          : 'Copy terminal resume command (claude --resume …)'
                      }
                      aria-label="Copy resume command"
                      onClick={() => void copyLocalResume(t())}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                        <path d="m2.5 4 3.5 4-3.5 4M8 12.5h5.5" />
                      </svg>
                    </Button>
                  </Show>
                </div>
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
                      <Show when={isPr && prStatuses.data?.previews[att.url]}>
                        <ExtLink
                          href={prStatuses.data!.previews[att.url]}
                          class="shrink-0"
                          title="Vercel deploy preview of this PR's branch"
                        >
                          Preview
                        </ExtLink>
                      </Show>
                      <Show when={isPr && prState(att.url) && prState(att.url) !== 'OPEN'}>
                        <Badge
                          class={`ml-auto shrink-0 ${prState(att.url) === 'MERGED' ? 'text-success' : 'text-text-faint'}`}
                        >
                          {prState(att.url) === 'MERGED' ? '✓ merged' : 'closed'}
                        </Badge>
                      </Show>
                      <Show when={isPr && (!prState(att.url) || prState(att.url) === 'OPEN')}>
                        <Button
                          variant="primary"
                          class="ml-auto h-6 shrink-0 px-2 text-[11px]"
                          loading={mergeBusy() === att.url}
                          title={
                            prStatuses.isError
                              ? 'PR state unknown — restart the bridge (npx linear-grab-bridge) for live merge status'
                              : 'Squash-merge this PR via the bridge gh — reviewed the demo? Ship it.'
                          }
                          onClick={() => void doMerge(att.url)}
                        >
                          <span class="inline-block min-w-[6ch] text-center">Merge</span>
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
            <Index each={issue()!.comments}>
              {(commentA) => {
                const comment = commentA();
                return (
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
                  <CommentBody text={comment.body} />
                </div>
                );
              }}
            </Index>
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
            onChange={(e) => {
              userSetTarget = true;
              setTarget(e.currentTarget.value);
            }}
          >
            <Show when={localTask()}>
              <option value="local" selected={target() === 'local'}>
                Message local Claude Code session
              </option>
            </Show>
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
            class={`size-7 shrink-0 px-0 ${grabSink() === 'composer' ? 'text-accent' : ''}`}
            title={
              grabSink() === 'composer'
                ? 'Pick mode ON — every pick appends here. Click to stop.'
                : 'Pick elements — refs append to this reply (stays on until toggled off or sent)'
            }
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
            class={`size-7 shrink-0 px-0 ${recSnap().phase === 'recording' ? 'text-danger' : ''}`}
            title={
              recSnap().phase === 'recording'
                ? 'Stop recording — the GIF auto-attaches to this reply'
                : 'Record a GIF from this thread (auto-attaches when done)'
            }
            aria-label="Record GIF"
            onClick={toggleRecord}
          >
            <Show
              when={recSnap().phase === 'recording'}
              fallback={<span class="bg-danger inline-block size-2.5 rounded-full" aria-hidden />}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <rect x="3" y="3" width="10" height="10" rx="1.5" />
              </svg>
            </Show>
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

  const statusWord = createMemo(() => {
    const s = props.session.status;
    if (/active/i.test(s)) return 'Working…';
    if (/awaitingInput|elicit/i.test(s)) return 'Needs input';
    if (/complete/i.test(s)) return 'Complete';
    if (/error/i.test(s)) return 'Error';
    if (/pending/i.test(s)) return 'Queued';
    return s;
  });

  // Last ~15 activities, rendered like Linear's session popup: markdown
  // paragraphs for thoughts/responses, compact mono rows for actions.
  const recentActivities = createMemo(() =>
    props.session.activities.filter((a) => a.content?.body || a.content?.action).slice(-15),
  );

  // Follow the live feed: stick to the BOTTOM (newest activity) as polls
  // append, but never yank the view while the user is scrolled up reading.
  let feedEl: HTMLDivElement | undefined;
  let nearBottom = true;
  const onFeedScroll = () => {
    if (!feedEl) return;
    nearBottom = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 40;
  };
  createEffect(() => {
    const len = recentActivities().length;
    if (!feedEl || !len || !nearBottom) return;
    requestAnimationFrame(() => {
      if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
    });
  });

  return (
    <div class="bg-surface border-border rounded-lg border p-2.5 flex flex-col gap-1.5">
      {/* Session header */}
      <div class="flex items-center gap-1.5 flex-wrap">
        <Show when={/active|pending/i.test(props.session.status)}>
          <Spinner size={12} />
        </Show>
        <Badge color={statusColor()}>{statusWord()}</Badge>
        <Show when={props.session.appUser?.displayName}>
          <span class="text-[11px] text-text-dim">
            {props.session.appUser!.displayName}
          </span>
        </Show>
        <span class="ml-auto tabular-nums text-[10.5px] text-text-faint">
          {timeAgo(props.session.updatedAt)}
        </span>
        <Show when={props.session.externalLinks?.[0]}>
          {(link) => (
            <ExtLink href={link().url} class="shrink-0" title="Open this run on the agent's site">
              {link().label || 'Cursor'}
            </ExtLink>
          )}
        </Show>
      </div>

      {/* Summary */}
      <Show when={props.session.summary}>
        <p class="text-[12px] text-text leading-relaxed whitespace-pre-wrap break-words">
          {props.session.summary}
        </p>
      </Show>

      {/* Live activity timeline — Index + memoized markdown so the 8s poll
          never rebuilds unchanged rows (the flicker rule). */}
      <Show when={recentActivities().length > 0}>
        <div
          ref={feedEl}
          onScroll={onFeedScroll}
          class="border-border mt-0.5 flex max-h-64 flex-col gap-1 overflow-y-auto border-t pt-1.5 pl-0.5 pr-3"
        >
          <Index each={recentActivities()}>
            {(activity) => (
              <Show
                when={activity().content.action}
                fallback={
                  <div
                    class={`lg-md text-[11.5px] leading-relaxed break-words ${
                      activity().content.__typename === 'AgentActivityErrorContent'
                        ? 'text-danger'
                        : 'text-text'
                    }`}
                  >
                    <CommentBody text={activity().content.body ?? ''} />
                  </div>
                }
              >
                <p class="font-mono text-text-faint text-[10.5px] leading-relaxed break-words">
                  → {activity().content.action} {activity().content.parameter}
                </p>
              </Show>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );
}
