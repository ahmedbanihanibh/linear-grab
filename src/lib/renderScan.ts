/**
 * Render Scan — the re-render auditor's analyzer, snapshot pass, and reporting.
 *
 * Sibling to slopScan: where slopScan grades the DESIGN contract off the live
 * DOM, this grades the RE-RENDER contract (`React-rerender-primitives.md`) off
 * recorded commits. Two inputs, two passes:
 *
 *  1. analyzeCommits(commits, rulebook) — the runtime pass. Aggregates a
 *     recording (from fiberCommits.ts) per component and flags the R-numbered
 *     re-render anti-patterns. Diagnoses are SUSPECTED (heuristic); the numbers
 *     (render counts, self ms) are exact measurements.
 *  2. runRenderSnapshotScan(root) — the passive DOM pass. One rule (R8) that
 *     needs no recording: interactive widgets used as static pictures.
 *
 * PURITY: like cssShared, this file imports ONLY types (from renderRulebook and
 * fiberCommits) plus the value FALLBACK not needed here — so it stays pure and
 * SSR-safe. All DOM access lives inside functions that receive a root, guarded
 * by a layout probe (copied from slopScan) so happy-dom's zero-rect world never
 * mass-flags or mass-skips.
 *
 * Every heuristic runs in its own try/catch: a throwing rule is skipped, the
 * rest still report (the slopScan discipline). Identical findings merge into
 * one carrying a `count` at the end.
 */

import type { RenderRulebook } from './renderRulebook';
import type { CommitRecord, FiberEntry } from './fiberCommits';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderFinding {
  /** The cited rule id ('R4' | 'R5' | …) or null for a pure budget finding. */
  ruleId: string | null;
  /** Part 0 shape family, or null when the finding is a raw measurement. */
  shape: 'A' | 'B' | 'C' | 'D' | null;
  severity: 'error' | 'warn';
  /** ALWAYS true for rule-attributed runtime findings — a diagnosis is a hint,
      the numbers are exact. */
  suspected: boolean;
  /** Starts `suspected R5 — …` when ruleId is set; a plain measurement else. */
  description: string;
  component: string | null;
  /** file:line — filled later by the store's attribution pass. */
  source: string | null;
  /** Total renders involved in this finding. */
  renders: number;
  /** Total self time (ms), rounded to 0.1. */
  selfTime: number;
  /** The churning prop names — the killer feature of the report. */
  changes: string[];
  /** Human numbers line, e.g. '65 renders · 42.3ms self · all props identity-equal'. */
  evidence: string;
  /** Merge multiplier for identical findings. */
  count?: number;
  /** Weak handle for panel click-to-flash + attribution. */
  el?: WeakRef<Element>;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Round to one decimal — every ms number in a finding is 0.1-rounded. */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Severity for a rule id, falling back to a given default when the doc lacks
    the rule (unreachable doc → FALLBACK_RULEBOOK has empty rules). */
function sevOf(rulebook: RenderRulebook, id: string, fallback: 'error' | 'warn'): 'error' | 'warn' {
  return rulebook.rules[id]?.severity ?? fallback;
}

/**
 * Framework-internal component names that are NOT the app's to fix — Next.js
 * dev-mode machinery (HotReload), app-router segment plumbing, and error/
 * loading boundaries. They re-render by design on every navigation and would
 * otherwise dominate reports and keep the headless baseline from converging.
 * Apps can extend the list via `.lineargrab.json` `renderIgnore` (exact names
 * or regex strings).
 */
const FRAMEWORK_NOISE =
  /^(HotReload|Head|AppRouterAnnouncer|HistoryUpdater|AppRouter|Router|ServerRoot|SegmentViewNode|SegmentViewStateNode|SegmentStateProvider|InnerLayoutRouter|OuterLayoutRouter|TemplateContext|RenderFromTemplateContext|ScrollAndFocusHandler|RedirectBoundary|RedirectErrorBoundary|LoadingBoundary|ErrorBoundary|ErrorBoundaryHandler|HTTPAccessFallbackBoundary|HTTPAccessFallbackErrorBoundary|DevRootHTTPAccessFallbackBoundary|__next_root_layout_boundary__|Preloads|NonIndex|ReplaySsrOnlyErrors|AppDevOverlay\w*|DevOverlay\w*|PseudoHtml\w*)$/;

/** Compile the caller's extra ignore names (exact strings or regex sources)
    into predicates; a bad regex source falls back to exact-match. */
function compileIgnore(ignore?: string[]): Array<(name: string) => boolean> {
  if (!ignore?.length) return [];
  return ignore.map((raw) => {
    try {
      const re = new RegExp(raw);
      return (name: string) => re.test(name);
    } catch {
      return (name: string) => name === raw;
    }
  });
}

function isIgnoredName(name: string, extra: Array<(n: string) => boolean>): boolean {
  // ≤2-char names are minified library internals (`tl`, `qs`) — nothing an app
  // owner can act on, and they churn per bundle rebuild.
  if (name.length <= 2) return true;
  if (FRAMEWORK_NOISE.test(name)) return true;
  for (const p of extra) if (p(name)) return true;
  return false;
}

/** A component's aggregated update renders across the whole recording. */
interface CompAgg {
  name: string;
  /** Every update render's change-set, in order. */
  updates: string[][];
  /** Total self time across all this component's entries. */
  selfTime: number;
  el?: WeakRef<Element>;
}

/** Aggregate per component (keyed by name) across the recording. */
function aggregateComponents(commits: CommitRecord[]): Map<string, CompAgg> {
  const map = new Map<string, CompAgg>();
  for (const commit of commits) {
    for (const e of commit.entries) {
      let agg = map.get(e.name);
      if (!agg) {
        agg = { name: e.name, updates: [], selfTime: 0, el: e.el ?? undefined };
        map.set(e.name, agg);
      }
      agg.selfTime += e.selfTime;
      if (e.el && !agg.el) agg.el = e.el;
      if (e.phase === 'update') agg.updates.push(e.changes);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// analyzeCommits — the runtime heuristics (rules 1–8)
// ---------------------------------------------------------------------------

export function analyzeCommits(
  commits: CommitRecord[],
  rulebook: RenderRulebook,
  opts?: { ignore?: string[] },
): RenderFinding[] {
  const findings: RenderFinding[] = [];

  // Strip framework-noise entries/mounts BEFORE any per-component rule runs —
  // commit durations stay untouched (the time was really spent; only the
  // component-level blame is not the app's to fix).
  const extra = compileIgnore(opts?.ignore);
  const filtered: CommitRecord[] = commits.map((c) => ({
    ...c,
    entries: c.entries.filter((e) => !isIgnoredName(e.name, extra)),
    mounts: Object.fromEntries(Object.entries(c.mounts).filter(([n]) => !isIgnoredName(n, extra))),
  }));

  const comps = aggregateComponents(filtered);
  const budgets = rulebook.budgets;

  // 1. wasted-render → R9, shape B: ≥5 update renders, ALL change-sets empty.
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    for (const c of comps.values()) {
      if (c.updates.length < 5) continue;
      if (!c.updates.every((u) => u.length === 0)) continue;
      const n = c.updates.length;
      out.push({
        ruleId: 'R9', shape: 'B', severity: sevOf(rulebook, 'R9', 'error'), suspected: true,
        description: `suspected R9 — ${c.name} re-rendered ${n}× with zero prop changes (dead memo or subscription-in-body)`,
        component: c.name, source: null, renders: n, selfTime: r1(c.selfTime), changes: [],
        evidence: `${n} renders · ${r1(c.selfTime)}ms self · all props identity-equal`,
        el: c.el,
      });
    }
    return out;
  });

  // 2. identity-churn → R5, shape B: ≥5 update renders, every change non-empty
  //    AND every change carries a (fn)/(ref) suffix. changes = distinct props.
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    for (const c of comps.values()) {
      if (c.updates.length < 5) continue;
      const allSuffixed = c.updates.every(
        (u) => u.length > 0 && u.every((ch) => /\((?:fn|ref)\)$/.test(ch)),
      );
      if (!allSuffixed) continue;
      const distinct = Array.from(new Set(c.updates.flat()));
      const n = c.updates.length;
      const propList = distinct.join(', ');
      out.push({
        ruleId: 'R5', shape: 'B', severity: sevOf(rulebook, 'R5', 'error'), suspected: true,
        description: `suspected R5 — ${n} renders of ${c.name} with fresh ${propList} identity per parent render (memo defeated)`,
        component: c.name, source: null, renders: n, selfTime: r1(c.selfTime), changes: distinct,
        evidence: `${n} renders · ${r1(c.selfTime)}ms self · churning ${propList}`,
        el: c.el,
      });
    }
    return out;
  });

  // 3. overlay-mount-burst → R4, shape A: in ONE commit mounts[name] ≥ 15, OR
  //    ≥ 10 for overlay-ish names (Tooltip/Menu/Popover/Context/Dialog/Dropdown).
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    const overlayRe = /Tooltip|Menu|Popover|Context|Dialog|Dropdown/i;
    for (const commit of filtered) {
      for (const name of Object.keys(commit.mounts)) {
        const count = commit.mounts[name];
        const threshold = overlayRe.test(name) ? 10 : 15;
        if (count < threshold) continue;
        // Nearest el for this name in this commit, if any.
        const entry = commit.entries.find((e) => e.name === name && e.el);
        out.push({
          ruleId: 'R4', shape: 'A', severity: sevOf(rulebook, 'R4', 'error'), suspected: true,
          description: `suspected R4 — ${count} ${name} instances mounted in one commit (per-row overlays should mount on intent)`,
          component: name, source: null, renders: count, selfTime: 0, changes: [],
          evidence: `${name} ×${count} mounted in one commit`,
          el: entry?.el ?? undefined,
        });
      }
    }
    return out;
  });

  // 4. slow-commit → ruleId null, shape null, error: commit.duration > commitMs.
  //    One per offending commit (identical merge happens at the end).
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    for (const commit of filtered) {
      if (commit.duration <= budgets.commitMs) continue;
      const top3 = [...commit.entries]
        .sort((a, b) => b.selfTime - a.selfTime)
        .slice(0, 3)
        .map((e) => `${e.name} ${r1(e.selfTime)}ms`)
        .join(', ');
      const dur = r1(commit.duration);
      const fps = commit.duration > 16 ? ` · ~${Math.round(1000 / commit.duration)} FPS` : '';
      out.push({
        ruleId: null, shape: null, severity: 'error', suspected: false,
        description: `commit exceeded budget: ${dur}ms of React work (> ${budgets.commitMs}ms) — top: ${top3}`,
        component: null, source: null, renders: commit.entries.length, selfTime: dur, changes: [],
        evidence: `${dur}ms commit · ${commit.entries.length} components${fps}`,
      });
    }
    return out;
  });

  // 5. hot-component → ruleId null, warn: a component over selfMs in ≥3 commits.
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    const perComp = new Map<string, { hits: number; worst: number; total: number; el?: WeakRef<Element> }>();
    for (const commit of filtered) {
      // Sum self time per component WITHIN a commit (a component may appear once,
      // but be defensive about multiple entries of the same name).
      const inCommit = new Map<string, number>();
      const elFor = new Map<string, WeakRef<Element>>();
      for (const e of commit.entries) {
        inCommit.set(e.name, (inCommit.get(e.name) ?? 0) + e.selfTime);
        if (e.el && !elFor.has(e.name)) elFor.set(e.name, e.el);
      }
      for (const [name, self] of inCommit) {
        if (self <= budgets.selfMs) continue;
        const rec = perComp.get(name) ?? { hits: 0, worst: 0, total: 0, el: elFor.get(name) };
        rec.hits += 1;
        rec.worst = Math.max(rec.worst, self);
        rec.total += self;
        if (!rec.el) rec.el = elFor.get(name);
        perComp.set(name, rec);
      }
    }
    for (const [name, rec] of perComp) {
      if (rec.hits < 3) continue;
      out.push({
        ruleId: null, shape: null, severity: 'warn', suspected: false,
        description: `${name} is a hot component: ${rec.hits} commits over the ${budgets.selfMs}ms self budget`,
        component: name, source: null, renders: rec.hits, selfTime: r1(rec.total), changes: [],
        evidence: `${rec.hits} commits over ${budgets.selfMs}ms self (worst ${r1(rec.worst)}ms)`,
        el: rec.el,
      });
    }
    return out;
  });

  // 6. scroll-setstate → R10, shape B: ≥5 nearInput commits in any rolling 1s window.
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    const times = commits.filter((c) => c.nearInput).map((c) => c.at).sort((a, b) => a - b);
    const n = maxInWindow(times, 1000);
    if (n >= 5) {
      out.push({
        ruleId: 'R10', shape: 'B', severity: sevOf(rulebook, 'R10', 'error'), suspected: true,
        description: `suspected R10 — ${n} React commits during scroll/pointer movement (frame-rate state updates)`,
        component: null, source: null, renders: n, selfTime: 0, changes: [],
        evidence: `${n} commits within a 1s scroll/pointer window`,
      });
    }
    return out;
  });

  // 7. commit-burst → R24, shape B, warn: ≥8 non-nearInput commits in any 300ms window.
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    const times = commits.filter((c) => !c.nearInput).map((c) => c.at).sort((a, b) => a - b);
    const { count: n, span } = maxInWindowSpan(times, 300);
    if (n >= 8) {
      out.push({
        ruleId: 'R24', shape: 'B', severity: sevOf(rulebook, 'R24', 'warn'), suspected: true,
        description: `suspected R24 — ${n} commits in ${Math.round(span)}ms burst (multi-row writes / un-coalesced pokes?)`,
        component: null, source: null, renders: n, selfTime: 0, changes: [],
        evidence: `${n} commits in a ${Math.round(span)}ms burst (no input)`,
      });
    }
    return out;
  });

  // 8. invisible-render → R3, shape C: ≥3 update renders while its host DOM is
  //    hidden/detached. Skipped entirely when the document root has zero layout
  //    (happy-dom guard — same probe as slopScan).
  runRule(findings, () => {
    const out: RenderFinding[] = [];
    if (!documentHasLayout()) return out; // no layout engine → can't judge visibility
    for (const c of comps.values()) {
      if (c.updates.length < 3) continue;
      const el = c.el?.deref();
      if (!el) continue;
      let hidden = false;
      try {
        const rect = el.getBoundingClientRect();
        hidden = !el.isConnected || (rect.width === 0 && rect.height === 0);
      } catch {
        continue;
      }
      if (!hidden) continue;
      const n = c.updates.length;
      out.push({
        ruleId: 'R3', shape: 'C', severity: sevOf(rulebook, 'R3', 'error'), suspected: true,
        description: `suspected R3 — ${c.name} re-rendered ${n}× while its DOM is hidden/detached (closed host without everOpened gate?) [R3/R7/R23 family]`,
        component: c.name, source: null, renders: n, selfTime: r1(c.selfTime), changes: [],
        evidence: `${n} renders while hidden/detached · ${r1(c.selfTime)}ms self`,
        el: c.el,
      });
    }
    return out;
  });

  return mergeFindings(findings);
}

// ---------------------------------------------------------------------------
// runRenderSnapshotScan — Phase-2 passive DOM pass (rule R8)
// ---------------------------------------------------------------------------

/** Selectors/ids owned by tooling, never the app — copied from slopScan. */
const SKIP_SEL = '#linear-grab-root, #claude-agent-glow-border, [id^="react-scan"]';

export function runRenderSnapshotScan(root: ParentNode = typeof document !== 'undefined' ? document : ({} as ParentNode)): RenderFinding[] {
  const findings: RenderFinding[] = [];

  runRule(findings, () => {
    const out: RenderFinding[] = [];
    const widgets = Array.from(root.querySelectorAll('[role="slider"], [role="progressbar"], [role="switch"]'));
    const hasLayout = documentHasLayoutFor(root);
    for (const el of widgets) {
      if (el.closest(SKIP_SEL)) continue; // never grade our own devtools chrome

      // Visibility skip (slopScan convention): only drop 0-size when a layout
      // engine exists — in happy-dom every rect is 0 and we must not drop all.
      if (hasLayout) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
        } catch {
          /* unreadable rect — grade it anyway */
        }
      }

      if (!isNonInteractive(el)) continue;

      const role = el.getAttribute('role') ?? 'widget';
      out.push({
        ruleId: 'R8', shape: 'D', severity: 'warn', suspected: true,
        description: `suspected R8 — interactive ${role} widget used as a static picture (mount a CSS mock instead)`,
        component: null, source: null, renders: 0, selfTime: 0, changes: [],
        evidence: excerpt(el),
        el: typeof WeakRef !== 'undefined' ? new WeakRef(el) : undefined,
      });
    }
    return out;
  });

  return mergeFindings(findings);
}

/** A widget is "non-interactive" (a picture) when disabled, aria-disabled, or
    pointer-events:none on itself or an ancestor within 3 levels. */
function isNonInteractive(el: Element): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  let cur: Element | null = el;
  for (let i = 0; cur && i <= 3; i++) {
    try {
      if (getComputedStyle(cur).pointerEvents === 'none') return true;
    } catch {
      /* getComputedStyle unavailable on this node — skip level */
    }
    cur = cur.parentElement;
  }
  return false;
}

/** tag + first two classes — the snapshot finding's evidence line. */
function excerpt(el: Element): string {
  const cls =
    typeof el.className === 'string' && el.className
      ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      : '';
  return `${el.tagName.toLowerCase()}${cls}`;
}

// ---------------------------------------------------------------------------
// Layout probes (happy-dom guard, from slopScan)
// ---------------------------------------------------------------------------

function documentHasLayout(): boolean {
  if (typeof document === 'undefined') return false;
  return (document.documentElement?.getBoundingClientRect().width ?? 0) > 0;
}

function documentHasLayoutFor(root: ParentNode): boolean {
  const docEl = (root as Document).documentElement ?? (typeof document !== 'undefined' ? document.documentElement : null);
  return (docEl?.getBoundingClientRect().width ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Rolling-window helpers (rules 6 & 7)
// ---------------------------------------------------------------------------

/** Max number of timestamps within any window of `ms` (sorted input). */
function maxInWindow(sorted: number[], ms: number): number {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > ms) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/** Max count within any `ms` window plus the span of that best window. */
function maxInWindowSpan(sorted: number[], ms: number): { count: number; span: number } {
  let bestCount = 0;
  let bestSpan = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > ms) lo++;
    const count = hi - lo + 1;
    if (count > bestCount) {
      bestCount = count;
      bestSpan = sorted[hi] - sorted[lo];
    }
  }
  return { count: bestCount, span: bestSpan };
}

// ---------------------------------------------------------------------------
// Rule isolation + merge (slopScan discipline)
// ---------------------------------------------------------------------------

/** Run one heuristic, swallowing throws so a broken rule never blocks others. */
function runRule(sink: RenderFinding[], rule: () => RenderFinding[]): void {
  try {
    sink.push(...rule());
  } catch {
    /* a throwing rule is skipped — every other rule still reports */
  }
}

/** Merge identical findings (ruleId|component|changes|description) into one
    with count = n — 30 identical rows bury the signal. */
function mergeFindings(findings: RenderFinding[]): RenderFinding[] {
  const merged = new Map<string, RenderFinding>();
  for (const f of findings) {
    const key = `${f.ruleId}|${f.component}|${f.changes.join()}|${f.description}`;
    const twin = merged.get(key);
    if (twin) twin.count = (twin.count ?? 1) + 1;
    else merged.set(key, f);
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Report + agent prompt
// ---------------------------------------------------------------------------

/**
 * Markdown report grouped by ruleId (mirrors formatSlopReport). Deterministic:
 * errors first, then count desc, then ruleId — snapshot-stable. Pure-budget
 * findings (ruleId null) group under a `budget` bucket.
 */
export function formatRenderReport(findings: RenderFinding[]): string {
  const groups = new Map<string, RenderFinding[]>();
  for (const f of findings) {
    const key = f.ruleId ?? 'budget';
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }

  const ordered = Array.from(groups.entries()).sort((a, b) => {
    const sevA = a[1][0].severity === 'error' ? 0 : 1;
    const sevB = b[1][0].severity === 'error' ? 0 : 1;
    if (sevA !== sevB) return sevA - sevB;
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  const total = findings.reduce((n, f) => n + (f.count ?? 1), 0);
  const errors = findings.filter((f) => f.severity === 'error').reduce((n, f) => n + (f.count ?? 1), 0);
  const lines = [
    `# Render scan — ${errors} error${errors === 1 ? '' : 's'}, ${total - errors} warn (${total} total)`,
    '',
    'Diagnoses are SUSPECTED (heuristic). The numbers (renders, self ms) are measured.',
    '',
  ];
  for (const [key, group] of ordered) {
    const f0 = group[0];
    const occurrences = group.reduce((n, f) => n + (f.count ?? 1), 0);
    lines.push(`## ${key} — ${f0.severity} ×${occurrences}`);
    for (const f of group) {
      const where = f.component || f.source ? ` — ${[f.component, f.source].filter(Boolean).join(' @ ')}` : '';
      const times = (f.count ?? 1) > 1 ? ` ×${f.count}` : '';
      lines.push(`- ${f.description}${times}${where}`);
      lines.push(`  ${f.evidence}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The render report wrapped as an agent-ready prompt (mirrors slopScanPrompt).
 * For each distinct ruleId present it embeds the rulebook's fixText (why the
 * rulebook is a param); when the doc lacks the id it points at the doc. It
 * states plainly that diagnoses are SUSPECTED while the numbers are measured.
 */
export function renderScanPrompt(findings: RenderFinding[], rulebook: RenderRulebook): string {
  const ids = Array.from(new Set(findings.map((f) => f.ruleId).filter((id): id is string => !!id))).sort();

  const fixes: string[] = [];
  for (const id of ids) {
    const rule = rulebook.rules[id];
    if (rule && rule.fixText) fixes.push(`- ${id} (${rule.slug}): ${rule.fixText}`);
    else fixes.push(`- ${id}: see React-rerender-primitives.md ${id}`);
  }

  return [
    'Below is a RENDER-SCAN report from my running app — each finding is a measured',
    'React re-render pattern graded against the re-render contract',
    '(`React-rerender-primitives.md`). Rules are R-numbered.',
    '',
    'READ THIS FIRST: the DIAGNOSES are SUSPECTED — they are heuristic guesses at the',
    'cause. The NUMBERS (render counts, self ms, FPS) are EXACT measurements. Trust the',
    'numbers; verify each diagnosis against the code before you "fix" it.',
    '',
    'How to fix:',
    '1. Fix at the source of the identity churn / wasted render, not the symptom —',
    '   stabilize props (useCallback/useMemo, hoist constants), gate work behind an',
    '   everOpened/visible check, mount per-row overlays on intent.',
    '2. Each distinct rule and its canonical fix:',
    ...fixes.map((f) => `   ${f}`),
    '3. PROOF REQUIRED: after the change I will re-record and re-scan — the flagged',
    '   components must show the render counts drop. State what you changed per',
    '   component; do not claim done blind.',
    '',
    '---',
    '',
    formatRenderReport(findings),
  ].join('\n');
}

// Keep the FiberEntry import meaningful for consumers reading the type surface.
export type { CommitRecord, FiberEntry };
