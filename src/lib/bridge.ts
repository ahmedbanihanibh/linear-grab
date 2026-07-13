import { getSettings } from './storage';

/**
 * Client for the local Claude Code bridge (`npx linear-grab-bridge`), which
 * runs interactive headless `claude -p` sessions in the repo: live status,
 * mid-run messages, model switching, usage telemetry, resumable sessions.
 */

export const DEFAULT_BRIDGE_URL = 'http://localhost:4577';

export interface BridgeHealth {
  ok: boolean;
  version: string;
  cwd: string;
  active: number;
}

export interface BridgeUsage {
  contextTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface BridgeTask {
  id: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  startedAt: number;
  endedAt: number | null;
  lastText: string;
  result: string | null;
  sessionId: string | null;
  model: string | null;
  pendingModel: string | null;
  /** Process still attached — messages go straight to stdin. Dead + sessionId
      = resumable (a message respawns via --resume). */
  alive: boolean;
  usage: BridgeUsage | null;
  subagents: number;
  permissionMode: string;
  worktree: { path: string; branch: string; removed: boolean } | null;
  tail?: Array<{ at: number; kind: string; text: string }>;
}

async function bridgeUrl(): Promise<string> {
  const s = await getSettings();
  return (s.bridgeUrl?.trim() || DEFAULT_BRIDGE_URL).replace(/\/$/, '');
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await bridgeUrl();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Bridge request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function fetchBridgeHealth(): Promise<BridgeHealth> {
  return call<BridgeHealth>('/health');
}

export async function listBridgeTasks(): Promise<BridgeTask[]> {
  const data = await call<{ tasks: BridgeTask[] }>('/tasks');
  return data.tasks;
}

export function fetchBridgeTask(id: string): Promise<BridgeTask> {
  return call<BridgeTask>(`/tasks/${id}`);
}

export function createBridgeTask(
  title: string,
  prompt: string,
  opts?: {
    model?: string;
    env?: Record<string, string>;
    permissionMode?: string;
    /** Run in an isolated git worktree + branch (parallel-safe). */
    worktree?: boolean;
  },
): Promise<BridgeTask> {
  return call<BridgeTask>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, prompt, ...opts }),
  });
}

/** Send a follow-up — mid-run it queues into the live session; after finish
    it resumes the session (also how a pending model switch takes effect). */
export function sendBridgeMessage(id: string, text: string): Promise<BridgeTask> {
  return call<BridgeTask>(`/tasks/${id}/message`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

/** Model change applies on the NEXT message (resume respawn) — never kills an
    in-flight turn. Empty string clears the override. */
export function setBridgeModel(id: string, model: string): Promise<BridgeTask> {
  return call<BridgeTask>(`/tasks/${id}/model`, {
    method: 'POST',
    body: JSON.stringify({ model: model || null }),
  });
}

/** Interrupt: kills the process; the session stays resumable via --resume. */
export function stopBridgeTask(id: string): Promise<void> {
  return call<{ ok: boolean }>(`/tasks/${id}/stop`, { method: 'POST' }).then(() => undefined);
}

export interface BridgeDiff {
  branch: string;
  baseCommit: string | null;
  files: Array<{ path: string; added: number; deleted: number; binary: boolean }>;
  untracked: string[];
  totalAdded: number;
  totalDeleted: number;
  prs: Array<{ url: string; title: string; state: string }>;
}

/** Remove a finished task's worktree (the branch survives for the PR). */
export function removeBridgeWorktree(id: string): Promise<BridgeTask> {
  return call<BridgeTask>(`/tasks/${id}/worktree/remove`, { method: 'POST' });
}

/** What the task changed in the repo (diffed against its start commit) + PRs. */
export function fetchBridgeDiff(id: string): Promise<BridgeDiff> {
  return call<BridgeDiff>(`/tasks/${id}/diff`);
}

/** Hand the panel's Linear auth to the bridge (media proxy). Best-effort. */
export async function pushBridgeConfig(): Promise<void> {
  const s = await getSettings();
  const auth = s.linearAccessToken ? `Bearer ${s.linearAccessToken}` : s.linearApiKey;
  if (!auth) return;
  await call<{ ok: boolean }>('/config', {
    method: 'POST',
    body: JSON.stringify({ linearAuth: auth }),
  }).catch(() => undefined);
}

/** Real PR states via the bridge's gh: OPEN | MERGED | CLOSED. */
export interface PrStatusInfo {
  statuses: Record<string, string>;
  /** Deploy-preview URLs (Vercel bot comments / PR body), keyed by PR url. */
  previews: Record<string, string>;
}

export async function fetchPrStatuses(urls: string[]): Promise<PrStatusInfo> {
  if (!urls.length) return { statuses: {}, previews: {} };
  const data = await call<Partial<PrStatusInfo>>('/pr/status', {
    method: 'POST',
    body: JSON.stringify({ urls }),
  });
  return { statuses: data.statuses ?? {}, previews: data.previews ?? {} };
}

/** Merge the PR's branch into the staging branch (deploys the staging preview). */
export function stagePr(url: string, base: string): Promise<{ ok: boolean; base?: string }> {
  return call<{ ok: boolean; base?: string }>('/pr/stage', {
    method: 'POST',
    body: JSON.stringify({ url, base }),
  });
}

export interface BranchDeployStatus {
  state: 'pending' | 'in_progress' | 'success' | 'failure' | 'error' | 'none' | 'unknown';
  url?: string | null;
  at?: string;
  sha?: string;
}

/** Live status of the staging branch's deploy (GitHub Deployments via gh). */
export function fetchBranchStatus(url: string, base: string): Promise<BranchDeployStatus> {
  return call<BranchDeployStatus>('/branch/status', {
    method: 'POST',
    body: JSON.stringify({ url, base }),
  });
}

/** One-click squash-merge via the bridge's gh. */
export function mergePr(url: string): Promise<{ ok: boolean; output?: string }> {
  return call<{ ok: boolean; output?: string }>('/pr/merge', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

/** Base URL for the media proxy (same as the bridge). */
export async function bridgeBase(): Promise<string> {
  const s = await getSettings();
  return (s.bridgeUrl?.trim() || DEFAULT_BRIDGE_URL).replace(/\/$/, '');
}

/** The exact command to continue this session in a terminal. */
export function resumeCommand(task: BridgeTask): string {
  return `claude --dangerously-skip-permissions --resume ${task.sessionId ?? '<session-id>'}`;
}
