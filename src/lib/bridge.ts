import { getSettings } from './storage';

/**
 * Client for the local Claude Code bridge (`npx linear-grab-bridge`), which
 * spawns headless `claude -p` sessions in the repo and reports their status.
 */

export const DEFAULT_BRIDGE_URL = 'http://localhost:4577';

export interface BridgeHealth {
  ok: boolean;
  version: string;
  cwd: string;
  active: number;
}

export interface BridgeTask {
  id: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  startedAt: number;
  endedAt: number | null;
  lastText: string;
  result: string | null;
  tail?: Array<{ at: number; text: string }>;
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

export function createBridgeTask(title: string, prompt: string): Promise<BridgeTask> {
  return call<BridgeTask>('/tasks', { method: 'POST', body: JSON.stringify({ title, prompt }) });
}

export function stopBridgeTask(id: string): Promise<void> {
  return call<{ ok: boolean }>(`/tasks/${id}/stop`, { method: 'POST' }).then(() => undefined);
}
