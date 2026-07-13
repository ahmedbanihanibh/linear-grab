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

/** Latest picker capture. Session-scoped: chrome.storage.session / sessionStorage. */
export async function getLastGrab(): Promise<GrabbedElement[] | null> {
  if (isExtensionContext) {
    const record = await chrome.storage.session.get(LAST_GRAB_KEY);
    return (record[LAST_GRAB_KEY] as GrabbedElement[] | undefined) ?? null;
  }
  return readPageJson<GrabbedElement[]>(sessionStorage, PAGE_GRAB_KEY);
}

export async function setLastGrab(elements: GrabbedElement[]): Promise<void> {
  if (isExtensionContext) {
    await chrome.storage.session.set({ [LAST_GRAB_KEY]: elements });
  } else {
    sessionStorage.setItem(PAGE_GRAB_KEY, JSON.stringify(elements));
    emit('grab');
  }
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
