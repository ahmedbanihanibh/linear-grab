import { createSignal, For, Show } from 'solid-js';
import { createQuery, createMutation, useQueryClient } from '@tanstack/solid-query';
import {
  fetchBridgeHealth,
  fetchBridgeTask,
  listBridgeTasks,
  stopBridgeTask,
  type BridgeTask,
} from '@/lib/bridge';
import { Button, Badge, EmptyState, Spinner, timeAgo } from '../components/ui';

/**
 * Local tab — delegate to and monitor LOCAL Claude Code sessions via the
 * bridge (`npx linear-grab-bridge` in the repo). Runs alongside cloud agents:
 * same drafts, different executor.
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

  const detail = createQuery(() => ({
    queryKey: ['bridge-task', expandedId()],
    queryFn: () => fetchBridgeTask(expandedId()!),
    refetchInterval: 2_000,
    enabled: !!expandedId() && !!health.data?.ok,
  }));

  const stopMut = createMutation(() => ({
    mutationFn: (id: string) => stopBridgeTask(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bridge-tasks'] }),
  }));

  const statusColor = (s: BridgeTask['status']) =>
    s === 'running'
      ? 'var(--color-accent)'
      : s === 'done'
        ? 'var(--color-success)'
        : s === 'stopped'
          ? 'var(--color-warn)'
          : 'var(--color-danger)';

  return (
    <div class="flex h-full flex-col">
      {/* Bridge status bar */}
      <div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span class="text-text text-[12px] font-semibold">Local Claude Code</span>
        <Show
          when={health.data?.ok}
          fallback={<Badge class="text-danger">bridge offline</Badge>}
        >
          <span class="text-text-faint max-w-[55%] truncate text-[10.5px] tabular-nums" title={health.data?.cwd}>
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
              tasks here. The bridge spawns headless <code>claude -p</code>{' '}
              sessions in the repo — your interactive terminal session stays
              untouched.
            </EmptyState>
          }
        >
          <Show
            when={(tasks.data ?? []).length > 0}
            fallback={
              <EmptyState title="No local tasks yet">
                Create an issue in Draft with "Delegate to → Local Claude Code",
                and it appears here with live status.
              </EmptyState>
            }
          >
            <div class="flex flex-col gap-1.5">
              <For each={tasks.data}>
                {(task) => (
                  <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
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

                    <div class="flex items-center gap-1.5">
                      <Badge color={statusColor(task.status)}>{task.status}</Badge>
                      <Button
                        variant="ghost"
                        class="ml-auto h-6 px-2 text-[11px]"
                        onClick={() => setExpandedId(expandedId() === task.id ? null : task.id)}
                      >
                        <span class="inline-block min-w-[4ch] text-center">
                          {expandedId() === task.id ? 'Hide' : 'Log'}
                        </span>
                      </Button>
                      <Show when={task.status === 'running'}>
                        <Button
                          variant="danger"
                          class="h-6 px-2 text-[11px]"
                          loading={stopMut.isPending}
                          onClick={() => stopMut.mutate(task.id)}
                        >
                          Stop
                        </Button>
                      </Show>
                    </div>

                    {/* Expanded transcript tail */}
                    <Show when={expandedId() === task.id}>
                      <div class="border-border bg-bg max-h-56 overflow-y-auto rounded-md border py-1.5 pl-2 pr-3">
                        <Show
                          when={(detail.data?.tail ?? []).length > 0}
                          fallback={<p class="text-text-faint text-[11px]">Waiting for output…</p>}
                        >
                          <For each={detail.data!.tail}>
                            {(line) => (
                              <p class="text-text-dim font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap">
                                {line.text}
                              </p>
                            )}
                          </For>
                        </Show>
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
