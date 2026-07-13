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
  prUrl?: string;
}

export interface AgentWatchSnapshot {
  /** Delegated + started, no PR yet — actively working. */
  running: RunningAgentIssue[];
  /** Delegated + started + PR linked — the agent finished, YOUR turn to review. */
  review: RunningAgentIssue[];
}

const POLL_MS = 30_000;
const PR_URL = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;

let snapshot: AgentWatchSnapshot = { running: [], review: [] };
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(snap: AgentWatchSnapshot) => void>();

export function getAgentWatch(): AgentWatchSnapshot {
  return snapshot;
}

export function subscribeRunningAgents(cb: (snap: AgentWatchSnapshot) => void): () => void {
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

function toEntry(i: LinearIssueSummary): RunningAgentIssue {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    stateName: i.state.name,
    stateColor: i.state.color,
    delegateName: i.delegate?.displayName ?? 'Agent',
    updatedAt: i.updatedAt,
    prUrl: i.attachments?.find((a) => PR_URL.test(a.url))?.url,
  };
}

async function poll(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.linearApiKey && !settings.linearAccessToken) return;
    const issues = await fetchMyIssues();
    const active = issues.filter((i) => !!i.delegate && i.state.type === 'started').map(toEntry);
    // A linked PR is the "I finished, review me" signal — agents often leave
    // the issue In Progress even when done.
    snapshot = {
      running: active.filter((i) => !i.prUrl),
      review: active.filter((i) => !!i.prUrl),
    };
    for (const cb of listeners) cb(snapshot);
  } catch {
    // Transient network/auth issue — keep the last known snapshot.
  }
}
