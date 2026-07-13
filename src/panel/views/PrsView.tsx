import { createMemo, createSignal, For, Show } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import { fetchMyIssues } from '@/lib/linear/api';
import { openPanelTo } from '../nav';
import { Badge, Button, EmptyState, StateDot, timeAgo } from '../components/ui';
import type { LinearAttachment, LinearIssueSummary } from '@/lib/types';

interface PrRow {
  issue: LinearIssueSummary;
  attachment: LinearAttachment;
}

const PR_URL = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;

/**
 * Pull requests produced by delegated issues — aggregated from issue
 * attachments (Cursor links its PR back to the issue automatically).
 */
export default function PrsView(props: { onOpenIssue: () => void }) {
  const query = createQuery(() => ({
    queryKey: ['my-issues'],
    queryFn: fetchMyIssues,
    refetchInterval: 15_000,
  }));

  const prs = createMemo<PrRow[]>(() =>
    (query.data ?? []).flatMap((issue) =>
      (issue.attachments ?? [])
        .filter((a) => PR_URL.test(a.url))
        .map((attachment) => ({ issue, attachment })),
    ),
  );

  const [copiedId, setCopiedId] = createSignal<string | null>(null);
  const copyUrl = async (row: PrRow) => {
    try {
      await navigator.clipboard.writeText(row.attachment.url);
      setCopiedId(row.attachment.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* clipboard denied */
    }
  };

  return (
    <div class="flex h-full flex-col">
      <div class="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span class="text-text text-[12px] font-semibold">Pull requests</span>
        <span class="text-text-faint text-[10.5px] tabular-nums">
          {prs().length} open from your issues
        </span>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pt-2 pb-3 pl-2 pr-3">
        <Show
          when={prs().length > 0}
          fallback={
            <EmptyState title="No PRs yet">
              {query.isError
                ? 'Connect Linear in Settings.'
                : 'PRs opened by delegated agents appear here as soon as they link back to your issues.'}
            </EmptyState>
          }
        >
          <div class="flex flex-col gap-1.5">
            <For each={prs()}>
              {(row) => (
                <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
                  <a
                    href={row.attachment.url}
                    target="_blank"
                    rel="noreferrer"
                    class="text-accent truncate text-[12.5px] font-medium hover:underline"
                    title={row.attachment.title}
                  >
                    {row.attachment.title || row.attachment.url}
                  </a>
                  <div class="flex min-w-0 items-center gap-1.5">
                    <StateDot color={row.issue.state.color} />
                    <span class="font-mono text-text-dim shrink-0 text-[11px]">
                      {row.issue.identifier}
                    </span>
                    <span class="text-text-dim truncate text-[11.5px]">{row.issue.title}</span>
                    <span class="text-text-faint ml-auto shrink-0 text-[10.5px] tabular-nums">
                      {timeAgo(row.issue.updatedAt)}
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <Badge>{row.issue.state.name}</Badge>
                    <Show when={row.issue.delegate}>
                      <Badge class="text-accent">⟠ {row.issue.delegate!.displayName}</Badge>
                    </Show>
                    <a
                      href={row.issue.url}
                      target="_blank"
                      rel="noreferrer"
                      class="text-accent ml-auto shrink-0 text-[11px] hover:underline"
                      title="Open the issue in Linear"
                    >
                      Open in Linear ↗
                    </a>
                    <Button
                      variant="ghost"
                      class="h-6 px-2 text-[11px]"
                      onClick={() => {
                        openPanelTo('activity', row.issue.id);
                        props.onOpenIssue();
                      }}
                    >
                      Issue
                    </Button>
                    <Button
                      variant="ghost"
                      class="h-6 px-2 text-[11px]"
                      onClick={() => void copyUrl(row)}
                    >
                      <span class="inline-block min-w-[5ch] text-center">
                        {copiedId() === row.attachment.id ? 'Copied' : 'Copy'}
                      </span>
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
