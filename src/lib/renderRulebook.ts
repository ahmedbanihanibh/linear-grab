/**
 * Render Rulebook — the pure parser for `React-rerender-primitives.md`.
 *
 * The project's re-render contract lives in a markdown doc; the Render Scan
 * cites its rule ids (R4, R5, R9…) the way slopScan cites primitives §ids. The
 * doc is fetched by the caller (panel/store layer) and handed to us as a raw
 * string — this module never touches the network, the filesystem, `window`, or
 * `document`. Zero imports, side-effect free, SSR-safe by construction.
 *
 * Everything here is tolerant: a rule section that doesn't parse is skipped,
 * never throws, so a doc edit that malforms one heading can't blind the whole
 * scan. When the doc is unreachable the caller falls back to FALLBACK_RULEBOOK
 * (budgets only, no rules — every finding then reads `see React-rerender-…`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderRule {
  /** `R4`, `R26`, … — the stable citation id. */
  id: string;
  /** The backticked slug, e.g. `per-row-overlays-mount-on-intent`. */
  slug: string;
  severity: 'error' | 'warn';
  /** The `**Rule:**` paragraph — what the contract demands. */
  ruleText: string;
  /** The `**Fix…:**` paragraph — the canonical remedy (label varies). */
  fixText: string;
  /** The `**Detect:**` paragraph — how the auditor spots it. */
  detectText: string;
}

export interface RenderRulebook {
  budgets: { selfMs: number; commitMs: number };
  /** Keyed by rule id (`R4`) so a finding resolves its fix in O(1). */
  rules: Record<string, RenderRule>;
}

/** Budgets are the doc's stated defaults; used when the doc is unreachable. */
export const FALLBACK_RULEBOOK: RenderRulebook = {
  budgets: { selfMs: 2, commitMs: 8 },
  rules: {},
};

// ---------------------------------------------------------------------------
// Heading parsing
// ---------------------------------------------------------------------------

/**
 * A rule heading looks like one of:
 *   ### R4 · `per-row-overlays-mount-on-intent` (error)
 *   ### R26 · `route-is-navigation-not-selection` — the hybrid focus mirror (error)
 *
 * We capture: id (R\d+), slug (first backticked token), and the LAST
 * `(error|warn)` on the line (a trailing prose clause may precede it). The
 * middot / em-dash / prose between slug and severity is deliberately ignored.
 */
const HEADING_RE = /^###\s+(R\d+)\s*[·.\-–—:]?\s*`([^`]+)`.*?\((error|warn)\)\s*$/;

/** Only a rule id in a `###` heading opens a rule; a plain `###`/`##`/`---`
    closes the previous body. Kept separate so the section splitter is simple. */
function isRuleHeading(line: string): boolean {
  return HEADING_RE.test(line.trim());
}

// ---------------------------------------------------------------------------
// Marker extraction (Rule / Fix / Detect)
// ---------------------------------------------------------------------------

/**
 * Pull the paragraph that follows a `**Label…:**` marker inside a rule body.
 *
 * `labelRe` matches the marker's leading text (e.g. /Rule/, /Fix/, /Detect/) so
 * label variants (`**Fix:**`, `**Fix (canonical: …):**`) all resolve. The body
 * runs until the NEXT `**Something:**` marker or a blank-line-then-marker — i.e.
 * the next bold marker at the start of a line. Markdown emphasis is stripped
 * minimally (`**`/`__` and single `*`/`_` around words) while code backticks
 * are preserved verbatim — a fix that says `useCallback` must keep its ticks.
 */
function extractMarker(body: string, labelRe: RegExp): string {
  const lines = body.split('\n');
  // Find the marker line: `**Label…:**  rest…` (rest may be empty).
  const markerLine = new RegExp(`^\\s*\\*\\*${labelRe.source}[^*]*:\\*\\*\\s*(.*)$`, 'i');
  const nextMarker = /^\s*\*\*[^*]+:\*\*/;

  let i = 0;
  for (; i < lines.length; i++) {
    if (markerLine.test(lines[i])) break;
  }
  if (i >= lines.length) return '';

  const first = lines[i].replace(markerLine, '$1');
  const collected: string[] = [];
  if (first.trim()) collected.push(first.trim());

  // Continue until the next marker, a heading/rule boundary, or EOF. A blank
  // line does NOT terminate on its own (marker may sit after a blank), but a
  // blank line FOLLOWED by a marker does — handled by the marker check.
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (nextMarker.test(line)) break;
    if (/^###\s/.test(line) || /^##\s/.test(line) || /^---\s*$/.test(line)) break;
    if (line.trim()) collected.push(line.trim());
    else if (collected.length) {
      // A blank line ends the paragraph only if we've already captured text and
      // the paragraph is prose (not continued by a following non-marker line).
      // Peek: if the next non-blank line is a marker/boundary, stop; else keep.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      if (nextMarker.test(lines[j]) || /^###\s|^##\s|^---\s*$/.test(lines[j])) break;
      // otherwise the paragraph continues after the blank — keep going, but do
      // not push the blank itself.
    }
  }

  return stripEmphasis(collected.join(' ')).trim();
}

/** Strip `**bold**`/`__bold__` and lone `*em*`/`_em_`, keep `code` backticks. */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_]([\s.,;:)]|$)/g, '$1$2$3')
    .replace(/\s{2,}/g, ' ');
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * The preamble states the commit budget, e.g.
 *   An interaction commit budget of **≤2ms self time**; any single commit >8ms …
 * selfMs from /≤(\d+)ms self/, commitMs from />(\d+)ms/. Either missing falls
 * back to the doc's stated defaults (2 / 8).
 */
function parseBudgets(md: string): { selfMs: number; commitMs: number } {
  const self = md.match(/≤(\d+(?:\.\d+)?)ms self/);
  // Anchor to the budget sentence — a bare />(\d+)ms/ would match the first
  // ">Nms" anywhere in the doc (incident numbers, prose) and silently change
  // the gate when the doc is edited.
  const commit = md.match(/commit >(\d+(?:\.\d+)?)ms/) ?? md.match(/>(\d+(?:\.\d+)?)ms of React work/);
  return {
    selfMs: self ? parseFloat(self[1]) : FALLBACK_RULEBOOK.budgets.selfMs,
    commitMs: commit ? parseFloat(commit[1]) : FALLBACK_RULEBOOK.budgets.commitMs,
  };
}

// ---------------------------------------------------------------------------
// parseRenderRulebook
// ---------------------------------------------------------------------------

export function parseRenderRulebook(md: string): RenderRulebook {
  const budgets = parseBudgets(md);
  const rules: Record<string, RenderRule> = {};

  const lines = md.split('\n');

  // Walk the doc, splitting on rule headings. A rule body runs from its heading
  // until the next rule heading, a `##` section, or a `---` rule.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!isRuleHeading(line)) {
      i++;
      continue;
    }
    // Collect the body up to (not including) the next boundary.
    const headingLine = line.trim();
    const bodyLines: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (isRuleHeading(l)) break;
      if (/^##\s/.test(l.trim()) || /^---\s*$/.test(l.trim())) break;
      bodyLines.push(l);
    }

    // Parse this one section defensively — a malformed section is skipped.
    try {
      const m = headingLine.match(HEADING_RE);
      if (m) {
        const [, id, slug, severity] = m;
        const body = bodyLines.join('\n');
        rules[id] = {
          id,
          slug,
          severity: severity === 'warn' ? 'warn' : 'error',
          ruleText: extractMarker(body, /Rule/),
          fixText: extractMarker(body, /Fix/),
          detectText: extractMarker(body, /Detect/),
        };
      }
    } catch {
      /* malformed section — skip, keep every other rule */
    }

    i = j;
  }

  return { budgets, rules };
}
