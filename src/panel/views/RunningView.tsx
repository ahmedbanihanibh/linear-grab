import { createMemo, createSignal, Index, Show } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import type { LinearAgentSession } from '@/lib/types';
import { fetchAllAgentSessions } from '@/lib/linear/api';
import { listBridgeTasks, type BridgeTask } from '@/lib/bridge';
import { fetchMyIssues } from '@/lib/linear/api';
import { openPanelTo } from '../nav';
import {
  Badge,
  Button,
  CloudIcon,
  EmptyState,
  MonitorIcon,
  Spinner,
  timeAgo,
} from '../components/ui';
import { IssueDetailScreen } from './ActivityView';

type Row =
  | { kind: 'cloud'; at: number; session: LinearAgentSession }
  | { kind: 'local'; at: number; task: BridgeTask; issueId?: string };

/**
 * Running tab — ONE view of every agent working right now, cloud and local.
 * The answer to "what's happening across my fleet" without hopping tabs.
 */
export default function RunningView() {
  const cloud = createQuery<LinearAgentSession[]>(() => ({
    queryKey: ['cloud-sessions'],
    queryFn: fetchAllAgentSessions,
    refetchInterval: 12_000,
  }));
  const local = createQuery(() => ({
    queryKey: ['bridge-tasks'],
    queryFn: listBridgeTasks,
    refetchInterval: 5_000,
    retry: 0,
  }));
  const issues = createQuery(() => ({
    queryKey: ['my-issues'],
    queryFn: fetchMyIssues,
    refetchInterval: 30_000,
  }));

  const rows = createMemo<Row[]>(() => {
    const cloudRows: Row[] = (cloud.data ?? [])
      .filter((s) => /active|pending|awaitingInput|elicit/i.test(s.status))
      .map((s) => ({ kind: 'cloud', at: Date.parse(s.updatedAt), session: s }));
    const localRows: Row[] = (local.data ?? [])
      .filter((t) => t.status === 'running')
      .map((t) => ({
        kind: 'local',
        at: t.startedAt,
        task: t,
        issueId: (issues.data ?? []).find((i) => t.title.startsWith(i.identifier))?.id,
      }));
    return [...cloudRows, ...localRows].sort((a, b) => b.at - a.at);
  });

  const [openIssue, setOpenIssue] = createSignal<string | null>(null);

  const cloudStatus = (s: string) =>
    /awaitingInput|elicit/i.test(s)
      ? { word: 'Needs input', color: 'var(--color-warn)' }
      : { word: 'Working…', color: 'var(--color-accent)' };

  const lastLine = (s: LinearAgentSession) => {
    const a = [...s.activities].reverse().find((x) => x.content?.body || x.content?.action);
    if (!a) return s.summary ?? '';
    return a.content.action
      ? `→ ${a.content.action} ${a.content.parameter ?? ''}`
      : (a.content.body ?? '');
  };

  return (
    <Show
      when={!openIssue()}
      fallback={<IssueDetailScreen issueId={openIssue()!} onBack={() => setOpenIssue(null)} />}
    >
      <div class="flex h-full flex-col">
        <div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
          <span class="text-text text-[12px] font-semibold">Running now</span>
          <span class="text-text-faint text-[10.5px] tabular-nums">
            {rows().length} agent{rows().length === 1 ? '' : 's'} active
          </span>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto pt-2 pb-3 pl-2 pr-3">
          <Show
            when={rows().length > 0}
            fallback={
              <EmptyState title="Nothing running">
                Delegate an issue from the Draft tab — cloud (Cursor) and local
                (Claude Code) agents working right now appear here together.
              </EmptyState>
            }
          >
            <div class="flex flex-col gap-1.5">
              {/* Index: poll-refreshed — update rows in place (flicker rule). */}
              <Index each={rows()}>
                {(r) => (
                  <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <Spinner size={12} />
                      <Badge
                        title={r().kind === 'cloud' ? 'Cursor cloud agent' : 'Local Claude Code'}
                      >
                        {r().kind === 'cloud' ? <CloudIcon /> : <MonitorIcon />}
                        {r().kind === 'cloud' ? 'cloud' : 'local'}
                      </Badge>
                      <button
                        class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                        title={r().kind === 'cloud' ? 'View the thread here' : 'Open the Local tab'}
                        onClick={() => {
                          const row = r();
                          if (row.kind === 'cloud' && row.session.issue)
                            setOpenIssue(row.session.issue.id);
                          else if (row.kind === 'local') openPanelTo('local');
                        }}
                      >
                        <Show when={r().kind === 'cloud'}>
                          <span class="font-mono text-text-dim shrink-0 text-[11px]">
                            {(r() as Extract<Row, { kind: 'cloud' }>).session.issue?.identifier}
                          </span>
                        </Show>
                        <span class="text-text hover:text-accent min-w-0 truncate text-[12.5px] font-medium transition-colors">
                          {r().kind === 'cloud'
                            ? ((r() as Extract<Row, { kind: 'cloud' }>).session.issue?.title ??
                              'Conversation session')
                            : (r() as Extract<Row, { kind: 'local' }>).task.title}
                        </span>
                      </button>
                      <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                        {timeAgo(r().at)}
                      </span>
                    </div>

                    <p class="text-text-dim line-clamp-2 text-[11.5px] leading-snug break-words">
                      {r().kind === 'cloud'
                        ? lastLine((r() as Extract<Row, { kind: 'cloud' }>).session)
                        : (r() as Extract<Row, { kind: 'local' }>).task.lastText}
                    </p>

                    <div class="flex min-w-0 items-center gap-1.5">
                      <Show
                        when={r().kind === 'cloud'}
                        fallback={<Badge color="var(--color-accent)">Working…</Badge>}
                      >
                        <Badge
                          color={
                            cloudStatus((r() as Extract<Row, { kind: 'cloud' }>).session.status)
                              .color
                          }
                        >
                          {
                            cloudStatus((r() as Extract<Row, { kind: 'cloud' }>).session.status)
                              .word
                          }
                        </Badge>
                      </Show>
                      <span class="ml-auto" />
                      <Button
                        variant="ghost"
                        class="size-6 shrink-0 px-0"
                        title={
                          r().kind === 'cloud'
                            ? 'Open the thread — steer this agent'
                            : 'Open the live session in the Local tab'
                        }
                        aria-label="Open thread"
                        onClick={() => {
                          const row = r();
                          if (row.kind === 'cloud' && row.session.issue)
                            setOpenIssue(row.session.issue.id);
                          else if (row.kind === 'local') openPanelTo('local');
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden>
                          <circle cx="8" cy="8" r="6" />
                          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
                        </svg>
                      </Button>
                    </div>
                  </div>
                )}
              </Index>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
