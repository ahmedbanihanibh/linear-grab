import { createEffect, createSignal, Show } from 'solid-js';
import { createQuery, createMutation, useQueryClient } from '@tanstack/solid-query';
import { fetchBranchStatus, fetchDeployLogs, resetStagingBranch } from '@/lib/bridge';
import { Badge, Button, ExtLink, Spinner } from './ui';

/**
 * Staging deploy tracker + terminal-style build logs (Vercel via the bridge).
 * Renders as an accordion card: status header always visible, logs on expand.
 */
export function BuildLogsCard(props: { url: string; base: string }) {
  const queryClient = useQueryClient();
  const status = createQuery(() => ({
    queryKey: ['stage-status', props.url, props.base],
    queryFn: () => fetchBranchStatus(props.url, props.base),
    refetchInterval: (q) =>
      q.state.data?.state === 'success' ||
      q.state.data?.state === 'failure' ||
      q.state.data?.state === 'error'
        ? false
        : 8_000,
    retry: 0,
  }));
  const building = () =>
    !['success', 'failure', 'error'].includes(status.data?.state ?? 'pending');

  const [open, setOpen] = createSignal(false);
  const logs = createQuery(() => ({
    queryKey: ['deploy-logs', status.data?.url ?? props.url],
    queryFn: () => fetchDeployLogs(status.data!.url!),
    enabled: open() && !!status.data?.url,
    refetchInterval: () => (building() ? 10_000 : false),
    retry: 0,
  }));

  // Terminal follows the tail while building (never yanks when scrolled up).
  let termEl: HTMLPreElement | undefined;
  let nearBottom = true;
  createEffect(() => {
    logs.data?.logs;
    if (!termEl || !nearBottom) return;
    requestAnimationFrame(() => {
      if (termEl) termEl.scrollTop = termEl.scrollHeight;
    });
  });

  const resetMut = createMutation(() => ({
    mutationFn: () => resetStagingBranch(props.url, props.base),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['stage-status', props.url, props.base] }),
  }));

  const word = () => {
    const st = status.data?.state;
    if (st === 'success') return { label: 'Ready', color: 'var(--color-success)' };
    if (st === 'failure' || st === 'error') return { label: 'Failed', color: 'var(--color-danger)' };
    if (st === 'none' || st === 'unknown') return { label: 'Waiting for deploy…', color: 'var(--color-text-dim)' };
    return { label: 'Building…', color: 'var(--color-accent)' };
  };

  return (
    <div class="border-border overflow-clip rounded-lg border">
      {/* Header — status word, deploy link, logs toggle, reset */}
      <div class="bg-surface-2 flex h-8 items-center gap-2 pl-2.5 pr-1.5">
        <Show when={building()} fallback={
          <span aria-hidden class="size-2 shrink-0 rounded-full" style={{ background: word().color }} />
        }>
          <Spinner size={11} />
        </Show>
        <span class="text-[11px] font-medium" style={{ color: word().color }}>
          {word().label}
        </span>
        <span class="text-text-faint font-mono text-[10px]">
          {props.base}
          {status.data?.sha ? ` @ ${status.data.sha}` : ''}
        </span>
        <span class="ml-auto" />
        <Show when={status.data?.state === 'success' && status.data?.url}>
          <ExtLink href={status.data!.url!} class="shrink-0" title="Open the staging deployment">
            Open
          </ExtLink>
        </Show>
        <Button
          variant="ghost"
          class="size-6 shrink-0 px-0"
          loading={resetMut.isPending}
          title={`Reset ${props.base} — delete + recreate from the default branch (drifted or conflicted staging)`}
          aria-label="Reset staging branch"
          onClick={() => resetMut.mutate()}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
            <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
            <path d="M2.5 12.5V8.9h3.6" />
          </svg>
        </Button>
        <Button
          variant="ghost"
          class="size-6 shrink-0 px-0"
          title={open() ? 'Hide build logs' : 'Show build logs (vercel inspect --logs via the bridge)'}
          aria-label={open() ? 'Hide build logs' : 'Show build logs'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
            <path d="m2.5 4 3.5 4-3.5 4M8 12.5h5.5" />
          </svg>
        </Button>
      </div>

      {/* Terminal */}
      <Show when={open()}>
        <Show
          when={status.data?.url}
          fallback={
            <p class="text-text-faint px-2.5 py-2 text-[10.5px]">
              No deployment URL yet — logs appear once Vercel picks up the branch.
            </p>
          }
        >
          <pre
            ref={termEl}
            onScroll={() => {
              if (!termEl) return;
              nearBottom = termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 40;
            }}
            class="font-mono max-h-56 overflow-auto px-2.5 py-2 pr-3 text-[10px] leading-relaxed whitespace-pre-wrap"
            style={{ background: '#0b0c0e', color: '#8b8e98' }}
          >
            <Show when={logs.data} fallback={<Spinner size={12} />}>
              {logs.data!.logs || 'No log output.'}
            </Show>
          </pre>
        </Show>
      </Show>
    </div>
  );
}
