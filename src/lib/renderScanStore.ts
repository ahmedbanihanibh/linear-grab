/**
 * Render-scan panel store — the impure shell around the pure engine in
 * renderScan.ts (sibling to slopScanStore). This file owns page annotation,
 * cumulative-by-page accumulation, the rulebook fetch/cache, react-grab source
 * attribution, and the bridge push.
 *
 * Accumulation model: findings are CUMULATIVE BY PAGE, exactly like the slop
 * store. A recording (or a snapshot) replaces the findings previously recorded
 * for the CURRENT pathname and keeps every other page's — so sweeping a flow
 * builds one combined report while re-recording a page after a fix overwrites
 * only that page. Snapshot findings and recording findings share the one store
 * (they merge naturally by page; there are not two stores).
 *
 * Recording (Phase 1) taps fiberCommits' React commit recorder; Snapshot
 * (Phase 2) is a passive DOM pass that needs no recording. Both funnel through
 * the same accumulate → attribute → bridge-push path.
 */

import { analyzeCommits, runRenderSnapshotScan, type RenderFinding } from './renderScan';
import {
  startCommitRecording,
  stopCommitRecording,
  drainCommits,
  type CommitRecord,
} from './fiberCommits';
import {
  parseRenderRulebook,
  FALLBACK_RULEBOOK,
  type RenderRulebook,
} from './renderRulebook';
import { bridgeBase } from './bridge';
import { getSettings } from './storage';

export type PageRenderFinding = RenderFinding & { page: string };

// ---------------------------------------------------------------------------
// Findings store (cumulative by page; panel subscribes)
// ---------------------------------------------------------------------------

let findings: PageRenderFinding[] = [];
const subs = new Set<(f: PageRenderFinding[]) => void>();

export function subscribeRenderFindings(cb: (f: PageRenderFinding[]) => void): () => void {
  subs.add(cb);
  cb(findings);
  return () => void subs.delete(cb);
}

export function clearRenderFindings(): void {
  findings = [];
  for (const cb of subs) cb(findings);
}

/** Accumulate a fresh batch for the current page: replace this page's findings,
    keep every other page's; then attribute sources and push to the bridge (the
    list paints immediately, sources fill in). Shared by record + snapshot. */
function accumulate(fresh: PageRenderFinding[], page: string): PageRenderFinding[] {
  findings = [...fresh, ...findings.filter((f) => f.page !== page)];
  for (const cb of subs) cb(findings);
  void attributeFindings(fresh).then(() => {
    findings = [...findings];
    for (const cb of subs) cb(findings);
    pushToBridge(fresh);
  });
  return fresh;
}

// ---------------------------------------------------------------------------
// Recording — fiber commit capture → analyze on stop
// ---------------------------------------------------------------------------

// Persisted-free (a recording is a live session, not a preference). The panel
// subscribes so its Record/Stop toggle + timer reflect the module-level truth
// even across a panel remount. Tracked with our own flag — NOT
// isCommitRecording() — because live mode also drives the recorder and must
// never masquerade as a manual recording after a remount.
const recSubs = new Set<(on: boolean, startedAt: number | null) => void>();
let manualRecording = false;
let startedAt: number | null = null;

export function subscribeRenderRecording(
  cb: (on: boolean, startedAt: number | null) => void,
): () => void {
  recSubs.add(cb);
  cb(manualRecording, startedAt);
  return () => void recSubs.delete(cb);
}

export function startRenderRecording(): void {
  if (liveEnabled || manualRecording) return; // live owns the recorder
  startCommitRecording();
  manualRecording = true;
  startedAt = Date.now();
  for (const cb of recSubs) cb(true, startedAt);
}

/** Stop the recorder, analyze the commits against the (cached) rulebook, tag
    with the current page, accumulate, attribute, and push. */
export async function stopRenderRecording(): Promise<PageRenderFinding[]> {
  if (!manualRecording) return [];
  const commits = stopCommitRecording();
  manualRecording = false;
  startedAt = null;
  for (const cb of recSubs) cb(false, null);
  const rulebook = await getRenderRulebook();
  const page = location.pathname;
  const fresh = analyzeCommits(commits, rulebook).map((f) => ({ ...f, page }));
  return accumulate(fresh, page);
}

// ---------------------------------------------------------------------------
// Live mode — the recorder stays on; a 3s tick re-analyzes a rolling buffer so
// findings stream in while you browse (the render-scan sibling of slop live)
// ---------------------------------------------------------------------------

// Persisted; default OFF (a standing fiber walk per commit is cheap but not
// free — opt in, like the slop live watcher).
let liveEnabled = false;
try {
  liveEnabled = localStorage.getItem('linear-grab:render-live') === '1';
} catch {
  /* storage blocked */
}
const liveSubs = new Set<(on: boolean) => void>();

export function renderLiveEnabled(): boolean {
  return liveEnabled;
}
export function subscribeRenderLive(cb: (on: boolean) => void): () => void {
  liveSubs.add(cb);
  cb(liveEnabled);
  return () => void liveSubs.delete(cb);
}

const LIVE_TICK_MS = 3000;
const LIVE_MAX_COMMITS = 4000;
let liveTimer: ReturnType<typeof setInterval> | null = null;
/** Rolling commit buffer for the CURRENT page — re-analyzed whole each tick so
    counts are cumulative for the page, not per-tick slivers. */
let liveCommits: CommitRecord[] = [];
let livePage = '';

export function setRenderLiveEnabled(on: boolean): void {
  if (on === liveEnabled) return;
  if (on && manualRecording) return; // the manual recording owns the recorder
  liveEnabled = on;
  try {
    localStorage.setItem('linear-grab:render-live', on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  for (const cb of liveSubs) cb(on);
  if (on) {
    startCommitRecording();
    liveCommits = [];
    livePage = location.pathname;
    liveTimer = setInterval(() => void liveTick(false), LIVE_TICK_MS);
  } else {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    void liveTick(true).finally(() => {
      stopCommitRecording();
      liveCommits = [];
    });
  }
}

/** One live analysis pass. Panel updates every tick; the expensive parts
    (source attribution + bridge push) run only when a page is FINISHED — on
    route change (the page you left) and on live-off (`finalPush`). */
async function liveTick(finalPush: boolean): Promise<void> {
  try {
    const page = location.pathname;
    if (page !== livePage) {
      const done = findings.filter((f) => f.page === livePage);
      void attributeFindings(done).then(() => {
        findings = [...findings];
        for (const cb of subs) cb(findings);
        pushToBridge(done);
      });
      liveCommits = [];
      livePage = page;
    }
    liveCommits.push(...drainCommits());
    if (liveCommits.length > LIVE_MAX_COMMITS) {
      liveCommits.splice(0, liveCommits.length - LIVE_MAX_COMMITS);
    }
    const rulebook = await getRenderRulebook();
    const fresh = analyzeCommits(liveCommits, rulebook).map((f) => ({ ...f, page }));
    findings = [...fresh, ...findings.filter((f) => f.page !== page)];
    for (const cb of subs) cb(findings);
    if (finalPush) {
      await attributeFindings(fresh);
      findings = [...findings];
      for (const cb of subs) cb(findings);
      pushToBridge(fresh);
    }
  } catch {
    /* a broken tick never kills live mode */
  }
}

/** Called once from page mount (like startSlopLiveWatch) — resumes a persisted
    live session after a reload. */
export function startRenderLiveWatch(): void {
  if (typeof window === 'undefined' || !liveEnabled || liveTimer) return;
  startCommitRecording();
  liveCommits = [];
  livePage = location.pathname;
  liveTimer = setInterval(() => void liveTick(false), LIVE_TICK_MS);
}

// ---------------------------------------------------------------------------
// Snapshot — Phase-2 passive DOM pass (no recording)
// ---------------------------------------------------------------------------

/** Grade the current DOM (rule R8) without a recording; same accumulate path. */
export function runSnapshotScan(): PageRenderFinding[] {
  const page = location.pathname;
  const fresh = runRenderSnapshotScan(document).map((f) => ({ ...f, page }));
  return accumulate(fresh, page);
}

// ---------------------------------------------------------------------------
// Rulebook — single source of fix text: the bridge serves the doc, we parse it
// ---------------------------------------------------------------------------

const RULEBOOK_TTL_MS = 5 * 60_000;
let cachedRulebook: RenderRulebook | null = null;
let cachedAt = 0;

/** Fetch + parse `React-rerender-primitives.md` from the bridge, cache it for
    5 minutes (timestamp check, no timers), and overlay any config budgets
    (config > doc > fallback). Every failure degrades to FALLBACK_RULEBOOK — the
    scan still runs, findings just cite bare rule ids. */
export async function getRenderRulebook(): Promise<RenderRulebook> {
  if (cachedRulebook && Date.now() - cachedAt < RULEBOOK_TTL_MS) return cachedRulebook;

  let parsed: RenderRulebook = FALLBACK_RULEBOOK;
  try {
    const base = await bridgeBase();
    const res = await fetch(`${base}/scan/rulebook`);
    const data = (await res.json()) as { ok?: boolean; text?: string };
    if (data.ok && data.text) parsed = parseRenderRulebook(data.text);
  } catch {
    /* bridge offline / doc missing — FALLBACK_RULEBOOK (budgets only) */
  }

  parsed = await withConfigBudgets(parsed);
  cachedRulebook = parsed;
  cachedAt = Date.now();
  return parsed;
}

/** The already-cached rulebook, or null if the first fetch hasn't landed. Lets
    the panel render a rule's slug synchronously (`R5 · identity-churn`) when we
    have it, without awaiting — the group header degrades to the bare id else. */
export function peekRenderRulebook(): RenderRulebook | null {
  return cachedRulebook;
}

/** Overlay .lineargrab.json's `renderBudgets` onto the parsed budgets. Read
    through the existing config path (Settings seeded from the committed file),
    so config > doc > fallback with no new fetch channel. */
async function withConfigBudgets(rulebook: RenderRulebook): Promise<RenderRulebook> {
  try {
    const s = await getSettings();
    const rb = s.renderBudgets;
    if (rb && (rb.selfMs != null || rb.commitMs != null)) {
      return {
        ...rulebook,
        budgets: {
          selfMs: rb.selfMs ?? rulebook.budgets.selfMs,
          commitMs: rb.commitMs ?? rulebook.budgets.commitMs,
        },
      };
    }
  } catch {
    /* settings unreadable — keep the doc/fallback budgets */
  }
  return rulebook;
}

// ---------------------------------------------------------------------------
// Attribution — fill file:line via react-grab's fiber source (clone slop store)
// ---------------------------------------------------------------------------

type GrabApi = {
  getDisplayName?: (el: Element) => string | null;
  getSource?: (el: Element) => Promise<{ filePath?: string | null; lineNumber?: number | null } | null>;
};

/** Fill source (and component, only when the finding lacks one) in place. One
    lookup per unique ELEMENT, capped so a huge recording can't stall. Recording
    findings already carry a fiber name — we never overwrite a non-null one. */
async function attributeFindings(list: PageRenderFinding[]): Promise<void> {
  let api: GrabApi | null = null;
  try {
    const rg = await import('react-grab');
    api = (rg.getGlobalApi() as GrabApi | null) ?? null;
  } catch {
    return; // react-grab unavailable — findings stay id-only
  }
  if (!api) return;

  const byEl = new Map<Element, PageRenderFinding[]>();
  for (const f of list) {
    const el = f.el?.deref();
    if (!el) continue;
    const group = byEl.get(el);
    if (group) group.push(f);
    else byEl.set(el, [f]);
  }
  let budget = 300; // unique-element lookups per batch
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
      // Never overwrite the fiber name a recording already carries.
      if (!f.component && component) f.component = component;
      if (source) f.source = source;
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge push — the scan log agents already read (kind "render-scan")
// ---------------------------------------------------------------------------

function pushToBridge(list: PageRenderFinding[]): void {
  if (list.length === 0) return;
  const at = Date.now();
  const events = list.slice(0, 200).map(({ el: _el, ...f }) => ({ kind: 'render-scan', at, ...f }));
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
