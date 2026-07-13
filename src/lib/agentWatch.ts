import { fetchMyIssues } from './linear/api';
import { getSettings } from './storage';
import type { LinearIssueSummary } from './types';

/**
 * Lightweight background watcher for RUNNING agent work — powers the launcher
 * pill's live status + minimap even while the panel is closed. "Running" =
 * my issue with an agent delegate in a started workflow state.
 *
 * Polls gently (30s) and only when Linear is connected. Page mode only —
 * the extension panel has no persistent context when closed.
 */
export interface RunningAgentIssue {
  id: string;
  identifier: string;
  title: string;
  stateName: string;
  stateColor: string;
  delegateName: string;
  updatedAt: string;
}

const POLL_MS = 30_000;

let running: RunningAgentIssue[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(issues: RunningAgentIssue[]) => void>();

export function getRunningAgents(): RunningAgentIssue[] {
  return running;
}

export function subscribeRunningAgents(cb: (issues: RunningAgentIssue[]) => void): () => void {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => void poll(), POLL_MS);
    void poll();
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Call after actions that change agent state (issue created, reply sent). */
export function refreshRunningAgents(): void {
  void poll();
}

async function poll(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.linearApiKey && !settings.linearAccessToken) return;
    const issues = await fetchMyIssues();
    running = issues.filter(isRunning).map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      stateName: i.state.name,
      stateColor: i.state.color,
      delegateName: i.delegate?.displayName ?? 'Agent',
      updatedAt: i.updatedAt,
    }));
    for (const cb of listeners) cb(running);
  } catch {
    // Transient network/auth issue — keep the last known list.
  }
}

function isRunning(issue: LinearIssueSummary): boolean {
  return !!issue.delegate && issue.state.type === 'started';
}
