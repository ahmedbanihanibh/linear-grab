import { isExtensionContext } from './env';
import type { GrabbedElement, Settings } from './types';

const SETTINGS_KEY = 'settings';
const LAST_GRAB_KEY = 'lastGrab';
const PAGE_SETTINGS_KEY = 'linear-grab:settings';
const PAGE_GRAB_KEY = 'linear-grab:last-grab';

export type StorageArea = 'settings' | 'grab';

/* In page mode, same-tab localStorage writes don't fire the 'storage' event,
   so change notification goes through this emitter. Extension mode uses
   chrome.storage.onChanged instead. */
const pageListeners = new Set<(area: StorageArea) => void>();
function emit(area: StorageArea) {
  for (const cb of pageListeners) cb(area);
}

function readPageJson<T>(store: Storage, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function getSettings(): Promise<Settings> {
  if (isExtensionContext) {
    const record = await chrome.storage.local.get(SETTINGS_KEY);
    return (record[SETTINGS_KEY] as Settings | undefined) ?? {};
  }
  return readPageJson<Settings>(localStorage, PAGE_SETTINGS_KEY) ?? {};
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  if (isExtensionContext) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  } else {
    localStorage.setItem(PAGE_SETTINGS_KEY, JSON.stringify(next));
    emit('settings');
  }
  return next;
}

/* Screenshots are multi-MB data URLs — persisting them INSIDE the grab list
   meant every publish pass re-stringified megabytes on the main thread (a
   real pick-freeze source). They live under separate per-grab keys instead;
   the list itself stays tiny metadata. */
const SHOT_PREFIX = 'linear-grab:shot:';
const shotKey = (grabbedAt: number) => `${SHOT_PREFIX}${grabbedAt}`;

/** Latest picker capture. Session-scoped: chrome.storage.session / sessionStorage. */
export async function getLastGrab(): Promise<GrabbedElement[] | null> {
  if (isExtensionContext) {
    const record = await chrome.storage.session.get(LAST_GRAB_KEY);
    const metas = (record[LAST_GRAB_KEY] as GrabbedElement[] | undefined) ?? null;
    if (!metas?.length) return metas;
    const shots = await chrome.storage.session.get(metas.map((m) => shotKey(m.grabbedAt)));
    return metas.map((m) => ({
      ...m,
      screenshotDataUrl: (shots[shotKey(m.grabbedAt)] as string | undefined) ?? undefined,
    }));
  }
  const metas = readPageJson<GrabbedElement[]>(sessionStorage, PAGE_GRAB_KEY);
  if (!metas?.length) return metas;
  return metas.map((m) => ({
    ...m,
    screenshotDataUrl: sessionStorage.getItem(shotKey(m.grabbedAt)) ?? undefined,
  }));
}

export async function setLastGrab(elements: GrabbedElement[]): Promise<void> {
  const metas = elements.map(({ screenshotDataUrl: _shot, ...meta }) => meta);
  if (isExtensionContext) {
    const shotWrites: Record<string, string> = {};
    for (const el of elements) {
      if (el.screenshotDataUrl) shotWrites[shotKey(el.grabbedAt)] = el.screenshotDataUrl;
    }
    await chrome.storage.session.set({ [LAST_GRAB_KEY]: metas, ...shotWrites });
  } else {
    for (const el of elements) {
      if (el.screenshotDataUrl) {
        try {
          sessionStorage.setItem(shotKey(el.grabbedAt), el.screenshotDataUrl);
        } catch {
          /* quota — skip the shot, keep the grab */
        }
      }
    }
    // Drop shots whose grab is gone.
    const live = new Set(metas.map((m) => shotKey(m.grabbedAt)));
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SHOT_PREFIX) && !live.has(key)) sessionStorage.removeItem(key);
    }
    sessionStorage.setItem(PAGE_GRAB_KEY, JSON.stringify(metas));
    emit('grab');
  }
}

/**
 * Multi-element capture: MERGE new grabs into the existing list instead of
 * replacing it. Same grabbedAt updates in place (screenshot/source passes);
 * same source file:line replaces the older pick; capped at 8 elements.
 */
export async function mergeGrabs(els: GrabbedElement[]): Promise<void> {
  const current = (await getLastGrab()) ?? [];
  const merged = [...current];
  for (const el of els) {
    const byId = merged.findIndex((m) => m.grabbedAt === el.grabbedAt);
    if (byId >= 0) {
      merged[byId] = {
        ...merged[byId],
        ...el,
        screenshotDataUrl: el.screenshotDataUrl ?? merged[byId].screenshotDataUrl,
        source: el.source ?? merged[byId].source,
      };
      continue;
    }
    if (el.source?.filePath) {
      const bySource = merged.findIndex(
        (m) =>
          m.source?.filePath === el.source!.filePath &&
          m.source?.lineNumber === el.source!.lineNumber,
      );
      if (bySource >= 0) {
        merged[bySource] = { ...merged[bySource], ...el };
        continue;
      }
    }
    merged.push(el);
  }
  // Final sweep: re-picking the same element must UPDATE, not accumulate —
  // enrichment passes match by id before the source dedupe can see them.
  const seen = new Set<string>();
  const deduped: GrabbedElement[] = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const g = merged[i];
    const key = g.source?.filePath
      ? `${g.source.filePath}:${g.source.lineNumber ?? ''}`
      : `id:${g.grabbedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.unshift(g);
  }
  await setLastGrab(deduped.slice(-8));
}

export async function removeGrab(grabbedAt: number): Promise<void> {
  const current = (await getLastGrab()) ?? [];
  await setLastGrab(current.filter((g) => g.grabbedAt !== grabbedAt));
}

export async function clearLastGrab(): Promise<void> {
  if (isExtensionContext) {
    await chrome.storage.session.remove(LAST_GRAB_KEY);
  } else {
    sessionStorage.removeItem(PAGE_GRAB_KEY);
    emit('grab');
  }
}

/**
 * Subscribe to storage changes regardless of host. Returns an unsubscribe fn.
 * Extension: chrome.storage.onChanged (local → settings, session → grab).
 * Page: local emitter fired by the save functions above.
 */
export function subscribeStorage(cb: (area: StorageArea) => void): () => void {
  if (isExtensionContext) {
    const listener = (_changes: unknown, areaName: string) => {
      if (areaName === 'local') cb('settings');
      if (areaName === 'session') cb('grab');
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  pageListeners.add(cb);
  return () => pageListeners.delete(cb);
}
