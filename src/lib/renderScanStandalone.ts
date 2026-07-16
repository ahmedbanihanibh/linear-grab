/**
 * Standalone render-scan bundle for the bridge's headless `audit --renders`.
 *
 * Sibling of slopScanStandalone: where that one grades the DESIGN contract off
 * the live DOM in a single synchronous pass, this one grades the RE-RENDER
 * contract off RECORDED React commits — so it must be injected and START
 * recording BEFORE React mounts, then finish after a scripted interaction.
 *
 * Built as an IIFE (vite.render.config.ts → dist/render-scan.global.js) and
 * injected into each audited page via CDP addScriptToEvaluateOnNewDocument, so
 * pages that never loaded linear-grab still get scanned. Exposes ONE global:
 *
 *   __RENDER_SCAN__.start()            → startCommitRecording()
 *   __RENDER_SCAN__.recording()        → is the recorder on
 *   __RENDER_SCAN__.finish(md?,budg?)  → stop + analyze + attribute → JSON findings
 *   __RENDER_SCAN__.snapshot()         → passive R8 DOM pass, attributed → JSON
 *   __RENDER_SCAN__.report(f)          → markdown report
 *   __RENDER_SCAN__.prompt(f, md?)     → agent fix prompt
 *   __RENDER_SCAN__.version
 *
 * Auto-start hook: when the bridge sets `window.__RENDER_SCAN_AUTOSTART__` (it
 * prepends `window.__RENDER_SCAN_AUTOSTART__=1;` to this source), the recorder
 * begins at module-eval time — which runs before the app's own scripts because
 * the bridge injects via addScriptToEvaluateOnNewDocument.
 *
 * Keep this file dependency-light: it pulls in ONLY the pure engine
 * (renderScan + renderRulebook) plus the ONE impure recorder (fiberCommits,
 * which owns bippy). Never the bridge/panel/react-grab graph — react-grab is
 * borrowed off `window.__REACT_GRAB__` at runtime when the audited app loaded it.
 */

import { safelyInstallRDTHook } from 'bippy';
import {
  analyzeCommits,
  runRenderSnapshotScan,
  formatRenderReport,
  renderScanPrompt,
  type RenderFinding,
} from './renderScan';
import {
  startCommitRecording,
  stopCommitRecording,
  isCommitRecording,
} from './fiberCommits';
import {
  parseRenderRulebook,
  FALLBACK_RULEBOOK,
  type RenderRulebook,
} from './renderRulebook';

/** A finding with the WeakRef stripped — WeakRefs can't cross the CDP boundary,
    and every remaining field is already JSON-safe (strings/numbers/arrays). */
export type SerializedFinding = Omit<RenderFinding, 'el'>;

type Budgets = { selfMs?: number; commitMs?: number };

/** Attribution borrowed from the audited page's own react-grab, exactly the way
    slopScanStandalone's runAttributed does — unique-element budget, resolve
    getDisplayName ONLY when the finding lacks a component (recordings already
    carry a fiber name), always try getSource. */
type GrabGlobal = {
  getDisplayName?: (el: Element) => string | null;
  getSource?: (el: Element) => Promise<{ filePath?: string | null; lineNumber?: number | null } | null>;
};

async function attribute(findings: RenderFinding[]): Promise<void> {
  const api = (window as unknown as { __REACT_GRAB__?: GrabGlobal }).__REACT_GRAB__;
  if (!api || (!api.getDisplayName && !api.getSource)) return;

  const byEl = new Map<Element, RenderFinding[]>();
  for (const f of findings) {
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

/** Strip the WeakRef so the finding survives JSON serialization over CDP. */
function serialize(findings: RenderFinding[]): SerializedFinding[] {
  return findings.map(({ el: _el, ...f }) => f);
}

/** config budgets > doc > fallback — same precedence as the panel store. */
function overlayBudgets(rulebook: RenderRulebook, budgets?: Budgets): RenderRulebook {
  if (!budgets || (budgets.selfMs == null && budgets.commitMs == null)) return rulebook;
  return {
    ...rulebook,
    budgets: {
      selfMs: budgets.selfMs ?? rulebook.budgets.selfMs,
      commitMs: budgets.commitMs ?? rulebook.budgets.commitMs,
    },
  };
}

function start(): void {
  startCommitRecording();
}

/** Stop, analyze against the rulebook (parsed from the passed markdown, else
    FALLBACK), attribute Component @ file:line, and return JSON-safe findings. */
async function finish(
  rulebookMd?: string,
  budgets?: Budgets,
  ignore?: string[],
): Promise<SerializedFinding[]> {
  const commits = stopCommitRecording();
  let rulebook = rulebookMd ? parseRenderRulebook(rulebookMd) : FALLBACK_RULEBOOK;
  rulebook = overlayBudgets(rulebook, budgets);
  const findings = analyzeCommits(commits, rulebook, { ignore });
  await attribute(findings);
  return serialize(findings);
}

/** Passive R8 DOM pass (no recording), attributed the same way. */
async function snapshot(): Promise<SerializedFinding[]> {
  const findings = runRenderSnapshotScan(document);
  await attribute(findings);
  return serialize(findings);
}

function report(findings: RenderFinding[]): string {
  return formatRenderReport(findings);
}

function prompt(findings: RenderFinding[], rulebookMd?: string): string {
  const rulebook = rulebookMd ? parseRenderRulebook(rulebookMd) : FALLBACK_RULEBOOK;
  return renderScanPrompt(findings, rulebook);
}

declare global {
  interface Window {
    __RENDER_SCAN__?: {
      version: string;
      start(): void;
      recording(): boolean;
      finish(rulebookMd?: string, budgets?: Budgets, ignore?: string[]): Promise<SerializedFinding[]>;
      snapshot(): Promise<SerializedFinding[]>;
      report(findings: RenderFinding[]): string;
      prompt(findings: RenderFinding[], rulebookMd?: string): string;
    };
    __RENDER_SCAN_AUTOSTART__?: unknown;
  }
}

window.__RENDER_SCAN__ = {
  version: import.meta.env?.VITE_LG_VERSION ?? 'dev',
  start,
  recording: isCommitRecording,
  finish,
  snapshot,
  report,
  prompt,
};

// Auto-start: the bridge injects this bundle via addScriptToEvaluateOnNewDocument
// with `window.__RENDER_SCAN_AUTOSTART__=1;` prepended, so module eval runs
// BEFORE React mounts. We install bippy's DevTools hook explicitly here (belt &
// suspenders — instrument() also installs lazily inside startCommitRecording,
// but at pre-React eval time we want the hook present the instant React looks
// for it, so no commit is missed) and begin recording immediately.
if (window.__RENDER_SCAN_AUTOSTART__) {
  try {
    safelyInstallRDTHook();
  } catch {
    /* hook already present / install refused — startCommitRecording still instruments */
  }
  start();
}
