import { createMemo, createSignal, For, Show } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import { fetchMyIssues } from '@/lib/linear/api';
import { mergePr } from '@/lib/bridge';
import { openPanelTo } from '../nav';
import { Badge, Button, EmptyState, ExtLink, StateDot, timeAgo } from '../components/ui';
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
  const [mergeBusy, setMergeBusy] = createSignal<string | null>(null);
  const [merged, setMerged] = createSignal<Set<string>>(new Set());
  const doMerge = async (url: string) => {
    setMergeBusy(url);
    try {
      await mergePr(url);
      setMerged((prev) => new Set(prev).add(url));
    } catch {
      /* surfaced via tooltip state remaining unmerged */
    } finally {
      setMergeBusy(null);
    }
  };
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
                  {/* Wrapping row + icon actions — never clips at narrow widths. */}
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge>{row.issue.state.name}</Badge>
                    <Show when={row.issue.delegate}>
                      <Badge class="text-accent">⟠ {row.issue.delegate!.displayName}</Badge>
                    </Show>
                    <ExtLink href={row.issue.url} class="shrink-0" title="Open the issue in Linear">
                      Linear
                    </ExtLink>
                    <div class="ml-auto flex shrink-0 items-center gap-1">
                      <Button
                        variant="primary"
                        class="size-7 px-0"
                        loading={mergeBusy() === row.attachment.url}
                        disabled={merged().has(row.attachment.url)}
                        title={merged().has(row.attachment.url) ? 'Merged' : 'Squash-merge this PR (bridge gh)'}
                        aria-label="Merge PR"
                        onClick={() => void doMerge(row.attachment.url)}
                      >
                        <Show
                          when={merged().has(row.attachment.url)}
                          fallback={
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                              <circle cx="4" cy="3.5" r="1.5" />
                              <circle cx="4" cy="12.5" r="1.5" />
                              <circle cx="12" cy="8" r="1.5" />
                              <path d="M4 5v6M4 6.5c0 2 2 3 4.5 3h2" />
                            </svg>
                          }
                        >
                          <span class="text-[12px] leading-none">✓</span>
                        </Show>
                      </Button>
                      <Button
                        variant="ghost"
                        class="size-7 px-0"
                        title="Open the issue's Activity thread"
                        aria-label="Open issue activity"
                        onClick={() => {
                          openPanelTo('activity', row.issue.id);
                          props.onOpenIssue();
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                          <circle cx="8" cy="8" r="6" />
                          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
                        </svg>
                      </Button>
                      <Button
                        variant="ghost"
                        class="size-7 px-0"
                        title="Copy PR URL"
                        aria-label="Copy PR URL"
                        onClick={() => void copyUrl(row)}
                      >
                        <Show
                          when={copiedId() === row.attachment.id}
                          fallback={
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden>
                              <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
                              <path d="M10.5 5.5v-2a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" />
                            </svg>
                          }
                        >
                          <span class="text-success text-[12px] leading-none">✓</span>
                        </Show>
                      </Button>
                    </div>
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
