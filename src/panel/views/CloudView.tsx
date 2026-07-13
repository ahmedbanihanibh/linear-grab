import { createMemo, Index, Show, For } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import type { LinearAgentSession } from '@/lib/types';
import { fetchAllAgentSessions } from '@/lib/linear/api';
import { openPanelTo } from '../nav';
import { persistentSignal } from '../persist';
import { Badge, Button, CloudIcon, EmptyState, ExtLink, Spinner, StateDot, timeAgo } from '../components/ui';

/**
 * Cloud tab — the workspace-wide fleet of Cursor agent sessions, the cloud
 * twin of the Local tab: live status, last activity, jump into the issue's
 * Activity thread to steer. Data = Linear's agentSessions (12s poll; GraphQL
 * subscriptions aren't available to third parties).
 */
export default function CloudView() {
  const sessions = createQuery<LinearAgentSession[]>(() => ({
    queryKey: ['cloud-sessions'],
    queryFn: fetchAllAgentSessions,
    refetchInterval: 12_000,
  }));

  type Filter = 'all' | 'working' | 'input' | 'done';
  const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'working', label: 'Working' },
    { id: 'input', label: 'Needs input' },
    { id: 'done', label: 'Done' },
  ];
  const [filter, setFilter] = persistentSignal<Filter>('cloud:filter', 'all');

  const filtered = createMemo(() =>
    (sessions.data ?? []).filter((s) => {
      switch (filter()) {
        case 'working':
          return /active|pending/i.test(s.status);
        case 'input':
          return /awaitingInput|elicit/i.test(s.status);
        case 'done':
          return /complete/i.test(s.status);
        default:
          return true;
      }
    }),
  );

  const statusWord = (s: string) =>
    /active/i.test(s)
      ? { word: 'Working…', color: 'var(--color-accent)' }
      : /awaitingInput|elicit/i.test(s)
        ? { word: 'Needs input', color: 'var(--color-warn)' }
        : /complete/i.test(s)
          ? { word: 'Complete', color: 'var(--color-success)' }
          : /error/i.test(s)
            ? { word: 'Error', color: 'var(--color-danger)' }
            : { word: s, color: 'var(--color-text-dim)' };

  const lastLine = (s: LinearAgentSession) => {
    const a = [...s.activities].reverse().find((x) => x.content?.body || x.content?.action);
    if (!a) return s.summary ?? '';
    return a.content.action
      ? `→ ${a.content.action} ${a.content.parameter ?? ''}`
      : (a.content.body ?? '');
  };

  const running = createMemo(
    () => (sessions.data ?? []).filter((s) => /active|pending/i.test(s.status)).length,
  );

  return (
    <div class="flex h-full flex-col">
      <div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span class="text-text inline-flex items-center gap-1.5 text-[12px] font-semibold">
          <CloudIcon size={13} /> Cloud agents
        </span>
        <span class="text-text-faint text-[10.5px] tabular-nums">
          {running()} working · updated {timeAgo(sessions.dataUpdatedAt || Date.now())}
        </span>
      </div>

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
        <Button
          class="ml-auto size-6 px-0"
          loading={sessions.isFetching}
          title="Refresh"
          aria-label="Refresh sessions"
          onClick={() => void sessions.refetch()}
        >
          <svg aria-hidden width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 4.5A7 7 0 0 1 13.5 3" />
            <path d="M15 11.5A7 7 0 0 1 2.5 13" />
            <polyline points="1 1 1 5 5 5" />
            <polyline points="15 11 15 15 11 15" />
          </svg>
        </Button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pt-2 pb-3 pl-2 pr-3">
        <Show
          when={filtered().length > 0}
          fallback={
            <Show
              when={!sessions.isPending}
              fallback={
                <div class="grid place-items-center py-10">
                  <Spinner />
                </div>
              }
            >
              <EmptyState title="No cloud agent sessions">
                Delegate an issue to Cursor from the Draft tab and its live
                session appears here.
              </EmptyState>
            </Show>
          }
        >
          <div class="flex flex-col gap-1.5">
            {/* Index: sessions refresh every poll — position-keyed rows update
                in place instead of rebuilding cards (the flicker rule). */}
            <Index each={filtered()}>
              {(s) => (
                <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <Show
                      when={/active|pending/i.test(s().status)}
                      fallback={
                        <span
                          aria-hidden
                          class="size-2 shrink-0 rounded-full"
                          style={{ background: statusWord(s().status).color }}
                        />
                      }
                    >
                      <Spinner />
                    </Show>
                    <Show when={s().issue} fallback={<span class="text-text-dim text-[12.5px]">Conversation session</span>}>
                      <span class="font-mono text-text-dim shrink-0 text-[11px]">
                        {s().issue!.identifier}
                      </span>
                      <span class="text-text min-w-0 truncate text-[12.5px] font-medium">
                        {s().issue!.title}
                      </span>
                    </Show>
                    <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                      {timeAgo(s().updatedAt)}
                    </span>
                  </div>

                  <Show when={lastLine(s())}>
                    <p class="text-text-dim line-clamp-2 text-[11.5px] leading-snug break-words">
                      {lastLine(s())}
                    </p>
                  </Show>

                  <div class="flex min-w-0 items-center gap-1.5">
                    <Badge color={statusWord(s().status).color}>
                      {statusWord(s().status).word}
                    </Badge>
                    <Show when={s().issue}>
                      <StateDot color={s().issue!.state.color} />
                      <span class="text-text-dim text-[11px]">{s().issue!.state.name}</span>
                    </Show>
                    <span class="ml-auto" />
                    <Show when={s().issue}>
                      <Button
                        variant="ghost"
                        class="h-6 shrink-0 px-2 text-[11px]"
                        title="Open the thread — steer this agent"
                        onClick={() => openPanelTo('activity', s().issue!.id)}
                      >
                        Thread
                      </Button>
                      <ExtLink href={s().issue!.url} class="shrink-0">
                        Linear
                      </ExtLink>
                    </Show>
                  </div>
                </div>
              )}
            </Index>
          </div>
        </Show>
      </div>
    </div>
  );
}
