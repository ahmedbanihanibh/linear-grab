import { createMemo, createSignal, For, Show } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import { fetchMyIssues } from '@/lib/linear/api';
import { fetchPrStatuses, listBridgeTasks, mergePr, stagePr } from '@/lib/bridge';
import { getSettings } from '@/lib/storage';
import { openPanelTo } from '../nav';
import { Badge, Button, CloudIcon, EmptyState, ExtLink, Input, MonitorIcon, StateDot, timeAgo } from '../components/ui';
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

  // Executor source: a bridge task matching the identifier = built locally.
  const bridgeTasks = createQuery(() => ({
    queryKey: ['bridge-tasks'],
    queryFn: listBridgeTasks,
    refetchInterval: 10_000,
    retry: 0,
  }));
  // Real merge state from gh (via bridge) — Linear attachments can't tell us.
  const prStatuses = createQuery(() => ({
    queryKey: ['pr-status', prs().map((r) => r.attachment.url).sort().join('|')],
    queryFn: () => fetchPrStatuses(prs().map((r) => r.attachment.url)),
    refetchInterval: 30_000,
    retry: 0,
    enabled: prs().length > 0,
  }));
  const prState = (row: PrRow) =>
    merged().has(row.attachment.url) ? 'MERGED' : prStatuses.data?.statuses[row.attachment.url];

  const isLocal = (row: PrRow) =>
    !!bridgeTasks.data?.some((t) => t.title.startsWith(row.issue.identifier));

  // Filters: state chips + free-text search.
  const [filter, setFilter] = createSignal<'all' | 'review' | 'open' | 'done'>('all');
  const [search, setSearch] = createSignal('');
  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    return prs().filter((row) => {
      const stateType = row.issue.state.type;
      // Buckets follow the PR's REAL state first (bridge gh lookup) — a
      // closed/merged PR is never 'Open' no matter what the issue says.
      const pr = prState(row); // 'MERGED' | 'CLOSED' | 'OPEN' | undefined
      if (filter() === 'review' && (stateType !== 'started' || pr === 'MERGED' || pr === 'CLOSED'))
        return false;
      if (
        filter() === 'open' &&
        (pr === 'MERGED' ||
          pr === 'CLOSED' ||
          !(stateType === 'started' || stateType === 'unstarted' || stateType === 'backlog'))
      )
        return false;
      if (filter() === 'done' && !(stateType === 'completed' || pr === 'MERGED' || pr === 'CLOSED'))
        return false;
      if (
        q &&
        ![row.attachment.title, row.issue.title, row.issue.identifier]
          .join(' ')
          .toLowerCase()
          .includes(q)
      ) {
        return false;
      }
      return true;
    });
  });

  const settingsQ = createQuery<import('@/lib/types').Settings>(() => ({ queryKey: ['settings'], queryFn: getSettings }));
  const stagingBranch = () => settingsQ.data?.stagingBranch?.trim() || 'staging';
  const [stageBusy, setStageBusy] = createSignal<string | null>(null);
  const [staged, setStaged] = createSignal<Set<string>>(new Set());
  const [stageError, setStageError] = createSignal<string | null>(null);
  const doStage = async (url: string) => {
    setStageBusy(url);
    setStageError(null);
    try {
      await stagePr(url, stagingBranch());
      setStaged((prev) => new Set(prev).add(url));
    } catch (err) {
      setStageError(err instanceof Error ? err.message : String(err));
    } finally {
      setStageBusy(null);
    }
  };

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
        <Show
          when={!prStatuses.isError}
          fallback={
            <span class="text-warn text-[10.5px]" title="Merge states come from gh via the bridge">
              states unknown — restart the bridge
            </span>
          }
        >
          <span class="text-text-faint text-[10.5px] tabular-nums">
            {filtered().length}/{prs().length} from your issues
          </span>
        </Show>
      </div>

      {/* Filter bar: state chips + search */}
      <div class="border-border flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5">
        <div class="bg-surface-2 border-border flex shrink-0 rounded-md border p-0.5">
          <For
            each={[
              { id: 'all', label: 'All' },
              { id: 'review', label: 'Review' },
              { id: 'open', label: 'Open' },
              { id: 'done', label: 'Done' },
            ] as const}
          >
            {(f) => (
              <button
                class={`rounded-[5px] px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  filter() === f.id
                    ? 'bg-surface-3 text-text'
                    : 'text-text-dim hover:text-text cursor-pointer'
                }`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            )}
          </For>
        </div>
        <Input
          class="h-6 min-w-0 flex-1 text-[11px]"
          placeholder="Search PRs…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pt-2 pb-3 pl-2 pr-3">
        <Show
          when={filtered().length > 0}
          fallback={
            <EmptyState title="No PRs yet">
              {query.isError
                ? 'Connect Linear in Settings.'
                : prs().length > 0
                  ? 'No PRs match the current filter.'
                  : 'PRs opened by delegated agents appear here as soon as they link back to your issues.'}
            </EmptyState>
          }
        >
          <div class="flex flex-col gap-1.5">
            <For each={filtered()}>
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
                  <Show when={prStatuses.data?.previews[row.attachment.url]}>
                    <ExtLink
                      href={prStatuses.data!.previews[row.attachment.url]}
                      class="shrink-0 self-start"
                      title="Vercel deploy preview of this PR's branch"
                    >
                      Preview
                    </ExtLink>
                  </Show>
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
                      <Badge class="text-accent"><CloudIcon /> {row.issue.delegate!.displayName}</Badge>
                    </Show>
                    <Show when={isLocal(row)}>
                      <Badge class="text-warn"><MonitorIcon /> local</Badge>
                    </Show>
                    <ExtLink href={row.issue.url} class="shrink-0" title="Open the issue in Linear">
                      Linear
                    </ExtLink>
                    <div class="ml-auto flex shrink-0 items-center gap-1">
                      <Show when={prState(row) && prState(row) !== 'OPEN'}>
                        <Badge
                          class={prState(row) === 'MERGED' ? 'text-success' : 'text-text-faint'}
                        >
                          {prState(row) === 'MERGED' ? '✓ merged' : 'closed'}
                        </Badge>
                      </Show>
                      <Button
                        variant="ghost"
                        class="size-7 shrink-0 px-0"
                        loading={stageBusy() === row.attachment.url}
                        title={
                          staged().has(row.attachment.url)
                            ? `On ${stagingBranch()} — staging preview deploying`
                            : `Merge into ${stagingBranch()} — deploys the staging preview domain`
                        }
                        aria-label="Merge to staging"
                        onClick={() => void doStage(row.attachment.url)}
                      >
                        <Show when={staged().has(row.attachment.url)} fallback={<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                            <path d="M8 2 14 5.5 8 9 2 5.5 8 2Z" />
                            <path d="M2 10.5 8 14l6-3.5" />
                          </svg>}>
                          <span class="text-success text-[11px]">✓</span>
                        </Show>
                      </Button>
                      <Button
                        variant="primary"
                        class="size-7 px-0"
                        classList={{ hidden: !!prState(row) && prState(row) !== 'OPEN' }}
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
