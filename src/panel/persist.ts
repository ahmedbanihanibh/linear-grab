import { createSignal, createEffect, type Signal } from 'solid-js';

/* Reload-proof UI state. An accidental refresh must never eat a half-written
   draft or an unsent reply — text fields hydrate from sessionStorage (per-tab,
   auto-clears when the tab closes; grabs already live there too). Empty values
   remove their key so storage doesn't accumulate. */

const PREFIX = 'linear-grab:ui:';

export function persistentSignal<T>(key: string, initial: T): Signal<T> {
  let hydrated = initial;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw != null) hydrated = JSON.parse(raw) as T;
  } catch {
    /* corrupt entry — fall back to initial */
  }
  const [get, set] = createSignal<T>(hydrated);
  createEffect(() => {
    const v = get();
    try {
      const empty =
        v == null || v === '' || v === 0 || v === false || (Array.isArray(v) && v.length === 0);
      if (empty) sessionStorage.removeItem(PREFIX + key);
      else sessionStorage.setItem(PREFIX + key, JSON.stringify(v));
    } catch {
      /* quota — typing must never throw */
    }
  });
  return [get, set];
}
