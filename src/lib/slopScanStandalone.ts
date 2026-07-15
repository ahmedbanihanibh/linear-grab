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

declare global {
  interface Window {
    __SLOP_SCAN__?: {
      version: string;
      run(): PlainSlopFinding[];
      report(findings: PlainSlopFinding[]): string;
      prompt(findings: PlainSlopFinding[]): string;
    };
  }
}

window.__SLOP_SCAN__ = {
  version: import.meta.env?.VITE_LG_VERSION ?? 'dev',
  run,
  report: formatSlopReport,
  prompt: slopScanPrompt,
};
