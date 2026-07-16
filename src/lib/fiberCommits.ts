/**
 * Fiber Commits — the React commit recorder behind the Render Scan.
 *
 * This is the ONE impure file in the render-scan trio: it owns the bippy fiber
 * commit hook and the input listeners. The analyzer (`renderScan.ts`) is pure
 * and consumes the plain `CommitRecord[]` this produces, so all React coupling
 * is quarantined here.
 *
 * bippy notes:
 *  - react-grab (also on this page) already installed the React DevTools hook.
 *    bippy's `instrument()` patches the hook ADDITIVELY, so calling it here does
 *    not clobber react-grab — but we still call it LAZILY, once, on the first
 *    `startCommitRecording()`, never at module top level. This file sits in an
 *    SSR-safe import graph; touching the hook at import time would run in a
 *    world where `window` may not exist.
 *  - Everything that walks a fiber is wrapped so a throwing walk never breaks
 *    the host page (the slopScan "a broken rule is skipped" discipline).
 */

import {
  getDisplayName,
  getNearestHostFiber,
  getTimings,
  instrument,
  isCompositeFiber,
  traverseRenderedFibers,
} from 'bippy';
import type { Fiber, FiberRoot } from 'bippy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FiberEntry {
  /** getDisplayName(fiber.type) ?? 'Anonymous'. */
  name: string;
  /** Self time (ms) from getTimings(fiber). */
  selfTime: number;
  phase: 'mount' | 'update';
  /**
   * Prop identity churn, e.g. ['prop:onClick(fn)','prop:style(ref)','prop:value'].
   * An EMPTY array on an update means the component re-rendered with ZERO prop
   * identity changes — a pure-waste candidate (dead memo / subscription-in-body).
   */
  changes: string[];
  /** Nearest host element at commit time, weak so it never retains DOM. */
  el: WeakRef<Element> | null;
}

export interface CommitRecord {
  /** performance.now() at commit. */
  at: number;
  /** Sum of entry selfTimes (ms). */
  duration: number;
  /** Composite fibers only, capped 200/commit by selfTime desc. */
  entries: FiberEntry[];
  /** How many composite entries were dropped by the 200-cap. */
  droppedEntries: number;
  /** Per component name → count of phase==='mount' this commit (NOT capped). */
  mounts: Record<string, number>;
  /** A scroll/wheel/pointermove fired within the last 100ms of this commit. */
  nearInput: boolean;
}

// ---------------------------------------------------------------------------
// Module state — all lazy, none touched at import time
// ---------------------------------------------------------------------------

/** instrument() is idempotent-guarded so we patch the hook exactly once. */
let instrumented = false;
let recording = false;
let buffer: CommitRecord[] = [];
/** Last scroll/wheel/pointermove timestamp (performance.now()); -Infinity idle. */
let lastInputAt = -Infinity;

const ENTRIES_PER_COMMIT = 200;
const MAX_COMMITS = 4000;
const INPUT_WINDOW_MS = 100;

// Named handlers so we can add and later remove the exact same references.
function onInput(): void {
  lastInputAt = now();
}
const INPUT_EVENTS = ['scroll', 'wheel', 'pointermove'] as const;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// changes computation — the killer signal
// ---------------------------------------------------------------------------

/**
 * Diff a fiber's prev/next memoizedProps into identity-change tokens.
 *
 * For each key present in EITHER prev or next (both may be null → {}), skipping
 * `children`: when `!Object.is(prev, next)` we classify —
 *   both functions            → `prop:${k}(fn)`   (fresh closure each render)
 *   both non-null objects that are shallow-equal → `prop:${k}(ref)` (new ref, same shape)
 *   otherwise                 → `prop:${k}`        (a genuine value change)
 * Mount phase carries no diff (changes = []).
 */
function computeChanges(prev: unknown, next: unknown): string[] {
  const a = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>;
  const b = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === 'children') continue;
    const pv = a[k];
    const nv = b[k];
    if (Object.is(pv, nv)) continue;
    if (typeof pv === 'function' && typeof nv === 'function') {
      out.push(`prop:${k}(fn)`);
    } else if (
      pv && nv && typeof pv === 'object' && typeof nv === 'object' &&
      shallowEqual(pv as Record<string, unknown>, nv as Record<string, unknown>)
    ) {
      out.push(`prop:${k}(ref)`);
    } else {
      out.push(`prop:${k}`);
    }
  }
  return out;
}

/** Own-enumerable-key shallow equality with Object.is on each value. */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-commit collection
// ---------------------------------------------------------------------------

function collectCommit(root: FiberRoot): void {
  const raw: FiberEntry[] = [];
  const mounts: Record<string, number> = {};

  traverseRenderedFibers(root, (fiber: Fiber, phase) => {
    // Ignore unmounts entirely; only grade composite fibers.
    if (phase === 'unmount') return;
    if (!isCompositeFiber(fiber)) return;

    const name = getDisplayName(fiber.type) ?? 'Anonymous';

    // Tally EVERY mount (not subject to the 200 entries cap).
    if (phase === 'mount') mounts[name] = (mounts[name] ?? 0) + 1;

    let selfTime = 0;
    try {
      selfTime = getTimings(fiber).selfTime || 0;
    } catch {
      /* timings unavailable for this fiber — count it as 0ms */
    }

    let changes: string[] = [];
    if (phase === 'update' && fiber.alternate) {
      try {
        changes = computeChanges(fiber.alternate.memoizedProps, fiber.memoizedProps);
      } catch {
        // Prop diff threw — mark an UNKNOWN change: an empty set means "pure
        // waste" to the analyzer (R9), and a failed diff must never assert that.
        changes = ['prop:(unknown)'];
      }
    }

    let el: WeakRef<Element> | null = null;
    try {
      const host = getNearestHostFiber(fiber);
      const node = host?.stateNode as Element | null | undefined;
      if (node && typeof WeakRef !== 'undefined' && node instanceof Element) {
        el = new WeakRef(node);
      }
    } catch {
      /* no host fiber — leave el null */
    }

    raw.push({ name, selfTime, phase: phase === 'mount' ? 'mount' : 'update', changes, el });
  });

  // Cap entries by selfTime desc, keeping a dropped count.
  raw.sort((x, y) => y.selfTime - x.selfTime);
  const entries = raw.slice(0, ENTRIES_PER_COMMIT);
  const droppedEntries = Math.max(0, raw.length - ENTRIES_PER_COMMIT);

  // duration = sum of ALL entry selfTimes (the full commit's React self work).
  let duration = 0;
  for (const e of raw) duration += e.selfTime;

  const at = now();
  const nearInput = at - lastInputAt <= INPUT_WINDOW_MS;

  buffer.push({ at, duration, entries, droppedEntries, mounts, nearInput });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Patch the React commit hook exactly once (SSR-safe, idempotent). */
function ensureInstrumented(): void {
  if (instrumented) return;
  if (typeof window === 'undefined') return;
  instrumented = true;
  try {
    instrument({
      onCommitFiberRoot: (_rendererID, root: FiberRoot) => {
        if (!recording) return;
        if (buffer.length >= MAX_COMMITS) return; // silently stop appending
        try {
          collectCommit(root);
        } catch {
          /* a throwing fiber walk must never break the host page */
        }
      },
    });
  } catch {
    /* hook install failed — recording will simply capture nothing */
  }
}

export function startCommitRecording(): void {
  if (typeof window === 'undefined') return;
  if (recording) return;
  buffer = [];
  lastInputAt = -Infinity;
  ensureInstrumented();
  try {
    for (const type of INPUT_EVENTS) {
      // capture:true so element (not just window) scrolls register; passive so
      // we never delay the very scroll we're measuring.
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
  } catch {
    /* addEventListener unavailable — proceed without input tracking */
  }
  recording = true;
}

export function stopCommitRecording(): CommitRecord[] {
  recording = false;
  try {
    for (const type of INPUT_EVENTS) {
      window.removeEventListener(type, onInput, { capture: true } as EventListenerOptions);
    }
  } catch {
    /* ignore */
  }
  const out = buffer;
  buffer = [];
  lastInputAt = -Infinity;
  return out;
}

export function isCommitRecording(): boolean {
  return recording;
}

/** Take the buffered commits WITHOUT stopping the recorder — the live scan's
    periodic tick. Draining also resets the 4000-commit cap (it counts the
    buffer, not the session), so a long live session never goes deaf. */
export function drainCommits(): CommitRecord[] {
  const out = buffer;
  buffer = [];
  return out;
}
