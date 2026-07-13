import { createSignal } from 'solid-js';

/**
 * Tiny cross-component navigation store — lets the page-mode launcher (which
 * lives outside <App>) deep-link the panel to a specific tab/issue (e.g. a
 * running agent clicked in the minimap popover).
 */
export type PanelTab = 'draft' | 'capture' | 'activity' | 'local' | 'prs' | 'settings';

const [requestedTab, setRequestedTab] = createSignal<PanelTab | null>(null);
const [requestedIssueId, setRequestedIssueId] = createSignal<string | null>(null);

export { requestedTab, requestedIssueId };

export function openPanelTo(tab: PanelTab, issueId?: string): void {
  setRequestedTab(tab);
  setRequestedIssueId(issueId ?? null);
}

/** Consume (clear) the pending request once the panel has applied it. */
export function consumeNavRequest(): void {
  setRequestedTab(null);
  setRequestedIssueId(null);
}
