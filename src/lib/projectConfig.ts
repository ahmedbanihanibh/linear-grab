import type { Settings } from './types';

/* .lineargrab.json — committed, per-repo defaults. SECRETS NEVER GO HERE:
   no API keys, no bot tokens, no passwords. The bridge serves it via /health;
   the panel seeds unset local settings from it (local values always win). */

export const SHAREABLE_KEYS = [
  'defaultTeamId',
  'defaultProjectId',
  'defaultLabelIds',
  'defaultRepo',
  'workflowMode',
  'cursorModel',
  'stagingBranch',
  'githubAssetsRepo',
  'skillPaths',
  'logUrl',
  'logLines',
  'issueTemplate',
  'testUsername',
  'renderBudgets',
] as const satisfies readonly (keyof Settings)[];

export type ShareableKey = (typeof SHAREABLE_KEYS)[number];

export function pickShareable(settings: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of SHAREABLE_KEYS) {
    const v = settings[k];
    if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Config seeds MISSING local values only — personal overrides always win. */
export function seedFromConfig(
  local: Settings,
  config: Partial<Settings>,
): Partial<Settings> | null {
  const patch: Partial<Settings> = {};
  for (const k of SHAREABLE_KEYS) {
    if (local[k] === undefined && config[k] !== undefined) {
      (patch as Record<string, unknown>)[k] = config[k];
    }
  }
  return Object.keys(patch).length ? patch : null;
}
