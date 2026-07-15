/**
 * Standalone slop-scan bundle for the bridge's headless `audit` command.
 *
 * Built as an IIFE (vite.slop.config.ts → dist/slop-scan.global.js) and
 * injected into each audited page via CDP Runtime.evaluate — pages that never
 * loaded linear-grab still get scanned. Exposes ONE global:
 *
 *   __SLOP_SCAN__.run()     → findings as plain JSON (WeakRefs stripped —
 *                             they can't cross the CDP boundary)
 *   __SLOP_SCAN__.report(f) → markdown report
 *   __SLOP_SCAN__.prompt(f) → agent fix prompt
 *   __SLOP_SCAN__.version
 *
 * Keep this file dependency-light: it must pull in ONLY the pure engine
 * (slopScan + cssShared), never the bridge/panel/react-grab graph.
 */

import { formatSlopReport, runSlopScan, slopScanPrompt, type SlopFinding } from './slopScan';

export type PlainSlopFinding = Omit<SlopFinding, 'el'>;

function run(): PlainSlopFinding[] {
  return runSlopScan(document).map(({ el: _el, ...f }) => f);
}

/** Attribution in headless: this bundle can't import react-grab, but the
    audited dev app usually loads linear-grab's page bundle, which puts the
    react-grab api on window.__REACT_GRAB__ — borrow it when present. */
type GrabGlobal = {
  getDisplayName?: (el: Element) => string | null;
  getSource?: (el: Element) => Promise<{ filePath?: string | null; lineNumber?: number | null } | null>;
};

async function runAttributed(): Promise<PlainSlopFinding[]> {
  const findings = runSlopScan(document);
  const api = (window as unknown as { __REACT_GRAB__?: GrabGlobal }).__REACT_GRAB__;
  if (api && (api.getDisplayName || api.getSource)) {
    const byEl = new Map<Element, SlopFinding[]>();
    for (const f of findings) {
      const el = f.el?.deref();
      if (!el) continue;
      const group = byEl.get(el);
      if (group) group.push(f);
      else byEl.set(el, [f]);
    }
    let budget = 300;
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
  return findings.map(({ el: _el, ...f }) => f);
}

declare global {
  interface Window {
    __SLOP_SCAN__?: {
      version: string;
      run(): PlainSlopFinding[];
      runAttributed(): Promise<PlainSlopFinding[]>;
      report(findings: PlainSlopFinding[]): string;
      prompt(findings: PlainSlopFinding[]): string;
    };
  }
}

window.__SLOP_SCAN__ = {
  version: import.meta.env?.VITE_LG_VERSION ?? 'dev',
  run,
  runAttributed,
  report: formatSlopReport,
  prompt: slopScanPrompt,
};
