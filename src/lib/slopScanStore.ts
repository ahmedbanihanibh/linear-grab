/**
 * Slop-scan panel store + live watcher (the impure shell around the pure
 * engine in slopScan.ts — this file owns page annotation, accumulation,
 * bridge push, and the route-change auto-scan).
 *
 * Accumulation model: findings are CUMULATIVE BY PAGE. A scan replaces the
 * findings previously recorded for the CURRENT pathname and keeps every other
 * page's — so sweeping a flow (dashboard → editor → settings) builds one
 * combined report, while re-scanning a page after a fix overwrites only that
 * page. "Fresh scan" = clear + scan.
 *
 * Live mode: while enabled, a route-change watcher re-scans automatically
 * ~1s after the pathname changes (SPA navigations included — polling, not a
 * history patch, so we never fight the app's router). Module-level state so
 * scans keep accumulating while the panel is closed (it unmounts when hidden).
 */

import { runSlopScan, type SlopFinding } from './slopScan';
import { bridgeBase } from './bridge';

export type PageSlopFinding = Omit<SlopFinding, never> & { page: string };

// ---------------------------------------------------------------------------
// Findings store (cumulative by page; panel subscribes)
// ---------------------------------------------------------------------------

let findings: PageSlopFinding[] = [];
const subs = new Set<(f: PageSlopFinding[]) => void>();

export function subscribeSlopFindings(cb: (f: PageSlopFinding[]) => void): () => void {
  subs.add(cb);
  cb(findings);
  return () => void subs.delete(cb);
}

export function clearSlopFindings(): void {
  findings = [];
  for (const cb of subs) cb(findings);
}

/** Scan the current page; replace this page's findings, keep other pages'.
    Attribution (Component @ file:line via react-grab's fiber source) runs
    asynchronously after the sync scan — the list paints immediately and the
    sources fill in; the bridge push waits for them so agents get locators. */
export function scanCurrentPage(): PageSlopFinding[] {
  const page = location.pathname;
  const fresh = runSlopScan(document).map((f) => ({ ...f, page }));
  findings = [...fresh, ...findings.filter((f) => f.page !== page)];
  for (const cb of subs) cb(findings);
  void attributeFindings(fresh).then(() => {
    findings = [...findings];
    for (const cb of subs) cb(findings);
    pushToBridge(fresh);
  });
  return fresh;
}

type GrabApi = {
  getDisplayName?: (el: Element) => string | null;
  getSource?: (el: Element) => Promise<{ filePath?: string | null; lineNumber?: number | null } | null>;
};

/** Fill component/source in place. One lookup per unique ELEMENT (many
    findings share one element), capped so a 1000-finding page can't stall. */
async function attributeFindings(list: PageSlopFinding[]): Promise<void> {
  let api: GrabApi | null = null;
  try {
    const rg = await import('react-grab');
    api = (rg.getGlobalApi() as GrabApi | null) ?? null;
  } catch {
    return; // react-grab unavailable — findings stay selector-only
  }
  if (!api) return;

  const byEl = new Map<Element, PageSlopFinding[]>();
  for (const f of list) {
    const el = f.el?.deref();
    if (!el) continue;
    const group = byEl.get(el);
    if (group) group.push(f);
    else byEl.set(el, [f]);
  }
  let budget = 300; // unique-element lookups per scan
  for (const [el, group] of byEl) {
    if (budget-- <= 0) break;
    let component: string | null = null;
    let source: string | null = null;
    try {
      component = api.getDisplayName?.(el) ?? null;
    } catch {
      /* fiber walk mid-render */
    }
    try {
      const s = await api.getSource?.(el);
      if (s?.filePath) source = `${s.filePath}${s.lineNumber != null ? `:${s.lineNumber}` : ''}`;
    } catch {
      /* no debug source in prod builds */
    }
    if (!component && !source) continue;
    for (const f of group) {
      f.component = component;
      f.source = source;
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge push — same scan log agents already read (kind "slop-scan")
// ---------------------------------------------------------------------------

function pushToBridge(list: PageSlopFinding[]): void {
  if (list.length === 0) return;
  const at = Date.now();
  const events = list.slice(0, 200).map(({ el: _el, ...f }) => ({ kind: 'slop-scan', at, ...f }));
  void bridgeBase()
    .then((base) =>
      fetch(`${base}/scan/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        keepalive: true,
      }),
    )
    .catch(() => {
      /* bridge offline — panel list still has it */
    });
}

// ---------------------------------------------------------------------------
// Live mode — auto re-scan on route change while enabled
// ---------------------------------------------------------------------------

// Persisted; default OFF (a scan costs ~1s of main thread — opt in, unlike
// the free event-driven CSS watcher).
let liveEnabled = false;
try {
  liveEnabled = localStorage.getItem('linear-grab:slop-live') === '1';
} catch {
  /* storage blocked */
}
const liveSubs = new Set<(on: boolean) => void>();

export function slopLiveEnabled(): boolean {
  return liveEnabled;
}
export function setSlopLiveEnabled(on: boolean): void {
  liveEnabled = on;
  try {
    localStorage.setItem('linear-grab:slop-live', on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  for (const cb of liveSubs) cb(on);
  // Turning it on scans right away — the page you're on is part of the sweep.
  if (on) scheduleLiveScan(300);
}
export function subscribeSlopLive(cb: (on: boolean) => void): () => void {
  liveSubs.add(cb);
  cb(liveEnabled);
  return () => void liveSubs.delete(cb);
}

let liveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLiveScan(delayMs: number): void {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveTimer = null;
    if (!liveEnabled) return;
    try {
      scanCurrentPage();
    } catch {
      /* a broken page never kills the watcher */
    }
  }, delayMs);
}

let watching = false;
/** Called once from page mount (like startCssSlowdownWatch). Polls the
    pathname — SPA routers pushState without any reliable event; a 500ms poll
    is free and never fights the app's history. */
export function startSlopLiveWatch(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!liveEnabled) return;
    scheduleLiveScan(1000); // let the new route settle before grading it
  }, 500);
}
