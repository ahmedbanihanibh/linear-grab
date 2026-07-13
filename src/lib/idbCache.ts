import type { QueryClient } from '@tanstack/solid-query';

/**
 * Tiny IndexedDB persistence for the query cache — issues, details, sessions
 * and PRs render instantly from the last known state while fresh data loads.
 * Zero deps; a Convex/RivetKit sync engine can replace this layer later
 * without touching the views (they only see the query cache).
 */

const DB_NAME = 'linear-grab';
const STORE = 'queries';
/** Only these query key prefixes are persisted. */
const PERSISTED_PREFIXES = ['my-issues', 'issue', 'sessions', 'teams', 'agents'];

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // e.g. blocked in private mode — cache is best-effort
    }
  });
}

function shouldPersist(queryKey: readonly unknown[]): boolean {
  return typeof queryKey[0] === 'string' && PERSISTED_PREFIXES.includes(queryKey[0]);
}

/**
 * Hydrate persisted entries into the client (only where no fresh data exists
 * yet), then persist future updates, debounced per key.
 */
export async function wireIdbCache(queryClient: QueryClient): Promise<() => void> {
  const db = await openDb();
  if (!db) return () => {};

  // ---- hydrate ----
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly').objectStore(STORE);
      const req = tx.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        try {
          const { queryKey, data } = cursor.value as { queryKey: unknown[]; data: unknown };
          if (shouldPersist(queryKey) && queryClient.getQueryData(queryKey) === undefined) {
            queryClient.setQueryData(queryKey, data, { updatedAt: 0 }); // 0 → immediately stale, refetches
          }
        } catch {
          /* skip corrupt entry */
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });

  // ---- persist on change (debounced per key) ----
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const { queryKey, queryHash } = event.query;
    if (!shouldPersist(queryKey)) return;
    const existing = pending.get(queryHash);
    if (existing) clearTimeout(existing);
    pending.set(
      queryHash,
      setTimeout(() => {
        pending.delete(queryHash);
        try {
          const data = queryClient.getQueryData(queryKey);
          if (data === undefined) return;
          db.transaction(STORE, 'readwrite')
            .objectStore(STORE)
            .put({ queryKey, data }, queryHash);
        } catch {
          /* best-effort */
        }
      }, 400),
    );
  });

  return () => {
    unsubscribe();
    for (const t of pending.values()) clearTimeout(t);
    db.close();
  };
}
