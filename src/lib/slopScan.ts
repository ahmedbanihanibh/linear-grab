/**
 * Slop Scan — the design-system drift auditor.
 *
 * A third auditor next to react-scan (render time) and cssSlowdown (timing).
 * This one scans the LIVE page DOM for violations of the Protocolbase / Linear
 * design contract (`Linear -primitives.md`) — off-vocabulary radii, missing
 * row tokens, iconless icon-buttons, unvirtualized scrollers, lying scroll
 * fades, uppercase micro-labels, box-shadows in "flat" editor surfaces, the
 * whole §42 transition group, and so on. Every rule cites the primitives §id
 * in its `description`, so a finding is always traceable back to the contract.
 *
 * Design constraints (mirror cssSlowdown.ts):
 *  - PURE DOM + TS. No bridge/app imports — the panel layer does the bridge
 *    push. The ONLY import is the pure kernel in ./cssShared so the §42 rules
 *    can never drift from the live timing engine.
 *  - ONE `querySelectorAll('*')` walk per scan, shared across every rule, with
 *    a lazy per-element getComputedStyle cache — that call is the expensive
 *    part on 1000s-node pages.
 *  - Every rule runs in try/catch: a single throwing rule is skipped, the rest
 *    still report. A broken rule must never kill the scan.
 *  - Our own panel subtree (#linear-grab-root) is ALWAYS skipped.
 */

import {
  easingViolation,
  elementSelector,
  isIntentionalMotion,
  jankPropsOf,
  parseMs,
} from './cssShared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlopFinding {
  ruleId: string;
  /** Which primitives Part/§ the rule enforces (for grouping/traceability). */
  part: string;
  severity: 'error' | 'warn';
  /** Human copy — MUST cite the §id so the report maps back to the contract. */
  description: string;
  /** Short unique-ish CSS path of the offending element. */
  selector: string;
  /** The offending computed value / class — what to look at. */
  evidence: string;
  /** Pathname the finding was recorded on — set by the panel store when scans
      accumulate across pages; the engine itself leaves it unset. */
  page?: string;
  /** Weak handle for click-to-highlight in the panel (no retention pressure). */
  el?: WeakRef<Element>;
}

/** Shared scan context handed to every rule — one walk, one cached css(). */
export interface ScanContext {
  root: ParentNode;
  /** Visible, non-panel elements from the single querySelectorAll('*') walk. */
  els: Element[];
  /** Lazy, memoized getComputedStyle — the expensive call, cached per element. */
  css(el: Element): CSSStyleDeclaration;
}

interface SlopRule {
  id: string;
  part: string;
  severity: 'error' | 'warn';
  description: string;
  check(ctx: ScanContext): SlopFinding[];
}

// ---------------------------------------------------------------------------
// Small shared helpers (scan-local — the §42 kernel lives in cssShared)
// ---------------------------------------------------------------------------

/** Build a finding, attaching a WeakRef so the panel can scroll/flash it. */
function finding(
  rule: Pick<SlopRule, 'id' | 'part' | 'severity' | 'description'>,
  el: Element,
  evidence: string,
): SlopFinding {
  return {
    ruleId: rule.id,
    part: rule.part,
    severity: rule.severity,
    description: rule.description,
    selector: elementSelector(el),
    evidence,
    el: typeof WeakRef !== 'undefined' ? new WeakRef(el) : undefined,
  };
}

/** happy-dom / SSR-safe rect read — rules read layout via plain access so a
    test's Object.defineProperty stub applies. Never destructure. */
function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

/** Parse "8px 8px 0 0" / "8px" style radius shorthand into a px number list.
    Non-px (%, calc) resolve to NaN and are treated as "can't verify → skip". */
function radiiPx(value: string): number[] {
  return value
    .split('/')            // horizontal / vertical radii — grade the horizontal set
    [0]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.endsWith('px') ? parseFloat(t) : NaN));
}

/** Normalize a computed color to a comparable "r,g,b[,a]" token, or null. */
function rgbTuple(color: string): string | null {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((p) => p.trim());
  return parts.join(',');
}

/** Mask-image signal — reads computed (mask-image / -webkit-mask-image) and
    falls back to the inline `style` attribute. The inline fallback keeps the
    rule correct where a computed-style engine omits mask longhands. */
function maskImageOf(el: Element, cs: CSSStyleDeclaration): string {
  const anyCs = cs as unknown as { maskImage?: string; webkitMaskImage?: string };
  const computed = anyCs.maskImage || anyCs.webkitMaskImage || '';
  if (computed && computed !== 'none') return computed;
  const inline = el.getAttribute('style') ?? '';
  const m = inline.match(/(?:^|;|\s)(?:-webkit-)?mask-image\s*:\s*([^;]+)/i);
  if (m && m[1].trim() && m[1].trim() !== 'none') return m[1].trim();
  return '';
}

const APPROVED_RADII = new Set([0, 8, 12, 16]);

// bg-secondary — the token that is NOT allowed as an active/selected fill.
const BG_SECONDARY = {
  light: rgbTuple('rgb(240, 240, 241)'), // #F0F0F1
  dark: rgbTuple('rgb(35, 35, 37)'),     // #232325
};

// Brand status trio — the ONLY raw hex allowed on UI (§ Part 1 / Part 5).
const STATUS_TRIO = new Set(['#50e3c2', '#ee0000', '#f5a623']);

const INTERACTIVE_SEL =
  'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], input, textarea, select';

// ---------------------------------------------------------------------------
// §42 hover-selector index (built ONCE per scan, shared by icon-button-no-hover)
// ---------------------------------------------------------------------------

/**
 * Collect every `:hover` selector on the page, with `:hover` stripped, so a
 * rule can ask "does any hover rule match this element" via `el.matches`.
 *
 * Three known walls, handled here so no rule re-implements them:
 *  (a) cross-origin sheets throw on `.cssRules` — try/catch per sheet, skip.
 *  (b) Tailwind v4 nests hover rules inside `@media (hover:hover)` / `@layer`
 *      blocks — RECURSE every CSSGroupingRule, never top-level only.
 *  (c) matching is done by the caller via `el.matches(sel)` on the stripped
 *      selector.
 */
function buildHoverSelectorIndex(doc: Document): string[] {
  const out: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      // Grouping rules (@media, @layer, @supports, @container) nest .cssRules.
      const grouping = rule as CSSGroupingRule;
      if (grouping.cssRules && grouping.cssRules.length) {
        visit(grouping.cssRules);
        continue;
      }
      const style = rule as CSSStyleRule;
      const sel = style.selectorText;
      if (sel && sel.includes(':hover')) {
        // Strip :hover so el.matches tests the base selector.
        out.push(sel.replace(/:hover/g, ''));
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* cross-origin sheet — .cssRules throws; skip silently */
    }
  }
  return out;
}

/** Does the element match ANY hover rule (base selector)? Bad selectors from
    strip are individually guarded so one malformed entry can't abort. */
function hasHoverRule(el: Element, hoverIndex: string[]): boolean {
  for (const sel of hoverIndex) {
    if (!sel.trim()) continue;
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* invalid stripped selector — ignore */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Predicates shared by several rules
// ---------------------------------------------------------------------------

function isIconOnlyButton(el: Element): boolean {
  if (!el.matches('button, [role="button"]')) return false;
  const svgs = el.querySelectorAll('svg');
  if (svgs.length === 0) return false;
  // Only content is the icon(s): no non-whitespace text.
  return (el.textContent ?? '').trim().length === 0;
}

function scrollAncestor(el: Element): Element | null {
  let p = el.parentElement;
  while (p) {
    try {
      const oy = getComputedStyleCached(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') return p;
    } catch {
      /* ignore */
    }
    p = p.parentElement;
  }
  return null;
}

// A tiny module-level cache pointer so scrollAncestor can reuse the scan's
// css() — set at the start of runSlopScan, cleared after.
let getComputedStyleCached: (el: Element) => CSSStyleDeclaration = (el) =>
  getComputedStyle(el);

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

// --- Radius vocabulary (§40 / Part 1 chrome table) -------------------------

const radiusVocabulary: SlopRule = {
  id: 'radius-vocabulary',
  part: '§40',
  severity: 'error',
  description:
    '§40: radius vocabulary is {8, 12, 16, full} — never rounded-md/[4px]/[6px]/[10px]. Off-vocabulary radius.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const cs = ctx.css(el);
      const value = cs.borderRadius;
      if (!value || value === '0px') continue;
      const radii = radiiPx(value);
      if (radii.some((r) => Number.isNaN(r))) continue; // %/calc — unverifiable
      const max = Math.max(...radii);
      if (max === 0) continue;
      // Fully-rounded (pill/circle): radius ≥ half the min dimension.
      const r = rectOf(el);
      const minDim = Math.min(r.width || 0, r.height || 0);
      if (minDim > 0 && max >= minDim / 2 - 0.5) continue;
      if (radii.every((rad) => APPROVED_RADII.has(rad))) continue;
      out.push(finding(this, el, `border-radius: ${value}`));
    }
    return out;
  },
};

// --- Row radius token (§40) ------------------------------------------------

const rowRadiusToken: SlopRule = {
  id: 'row-radius-token',
  part: '§40',
  severity: 'error',
  description:
    '§40: list rows consume --row-radius (8px) or 0 — no bespoke per-surface row radius.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const r = rectOf(el);
      const h = r.height;
      if (h < 26 || h > 50) continue; // row-height heuristic
      const scroller = scrollAncestor(el);
      if (!scroller) continue;
      // ≥3 siblings at roughly the same height = a list.
      const parent = el.parentElement;
      if (!parent) continue;
      const sibs = Array.from(parent.children).filter((c) => {
        const cr = rectOf(c);
        return Math.abs(cr.height - h) < 2;
      });
      if (sibs.length < 3) continue;
      const radii = radiiPx(ctx.css(el).borderRadius);
      if (radii.some((rad) => Number.isNaN(rad))) continue;
      const max = Math.max(0, ...radii);
      if (max === 0 || max === 8) continue;
      out.push(finding(this, el, `row radius ${ctx.css(el).borderRadius} (want 0 or var(--row-radius)=8px)`));
    }
    return out;
  },
};

// --- Active fill token (§11, §40) ------------------------------------------

const activeFillToken: SlopRule = {
  id: 'active-fill-token',
  part: '§11',
  severity: 'error',
  description:
    '§11: active/selected fill must be var(--selected) (theme-safe) — never bg-secondary (#F0F0F1 / #232325).',
  check(ctx) {
    const out: SlopFinding[] = [];

    // PRECONDITION: computed styles erase token provenance. If --selected
    // resolves to the SAME color as bg-secondary for this theme, we cannot
    // tell an offending bg-secondary from a correct var(--selected) — the rule
    // is blind. Emit ONE warn instead of silently passing.
    let selectedTuple: string | null = null;
    try {
      const rootEl = (ctx.root as Document).documentElement ?? document.documentElement;
      if (rootEl) {
        const rootCss = ctx.css(rootEl);
        selectedTuple = rgbTuple(rootCss.getPropertyValue('--selected').trim());
      }
    } catch {
      /* no :root access — proceed without the precondition */
    }
    const bgSecondaryTuples = [BG_SECONDARY.light, BG_SECONDARY.dark].filter(Boolean) as string[];
    if (selectedTuple && bgSecondaryTuples.includes(selectedTuple)) {
      const rootEl = (ctx.root as Document).documentElement ?? document.documentElement;
      return [
        finding(
          { id: this.id, part: this.part, severity: 'warn', description:
            '§11: active-fill-token unverifiable — --selected resolves EQUAL to bg-secondary this theme; cannot distinguish the token from the anti-pattern.' },
          rootEl ?? ctx.els[0],
          `--selected == bg-secondary (${selectedTuple})`,
        ),
      ];
    }

    for (const el of ctx.els) {
      // nav/list context: a selectable tab/row/button.
      const navish =
        el.matches('[role="tab"], [role="button"], [aria-selected], [role="option"]') ||
        !!el.closest('[role="tablist"], [role="menu"], [data-rail], nav');
      if (!navish) continue;
      const bg = rgbTuple(ctx.css(el).backgroundColor);
      if (!bg) continue;
      if (bgSecondaryTuples.includes(bg)) {
        out.push(finding(this, el, `background bg-secondary (${ctx.css(el).backgroundColor}) — use var(--selected)`));
      }
    }
    return out;
  },
};

// --- Inline-style state (§40) ----------------------------------------------

const inlineStyleState: SlopRule = {
  id: 'inline-style-state',
  part: '§40',
  severity: 'error',
  description:
    '§40: the shared row-action class owns ALL visual states; inline styles carry LAYOUT ONLY — an inline background/color kills the class state.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const isRowAction = /pb-row-action|row-action/.test(cls);
      if (!isRowAction) continue;
      const inline = el.getAttribute('style') ?? '';
      if (/(^|;|\s)(background|color)\s*:/.test(inline)) {
        out.push(finding(this, el, `inline style="${inline}" on a row-action element`));
      }
    }
    return out;
  },
};

// --- Icon button: no hover affordance (§21 addendum / Part 10) --------------

const iconButtonNoHover: SlopRule = {
  id: 'icon-button-no-hover',
  part: '§40',
  severity: 'warn',
  description:
    '§40/Part 10: every interactive control changes color on hover — icon-only button with no :hover rule and no .pb-row-action.',
  check(ctx) {
    const out: SlopFinding[] = [];
    const doc = (ctx.root as Document).styleSheets
      ? (ctx.root as Document)
      : document;
    const hoverIndex = buildHoverSelectorIndex(doc);
    for (const el of ctx.els) {
      if (!isIconOnlyButton(el)) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/pb-row-action|row-action/.test(cls)) continue; // token carries hover
      // JS-driven hover (framer-motion / will-change) leaves no CSS trace — skip.
      if (el.hasAttribute('data-framer-appear-id') || Array.from(el.attributes).some((a) => a.name.startsWith('data-framer'))) continue;
      if (ctx.css(el).willChange.includes('transform')) continue;
      if (hasHoverRule(el, hoverIndex)) continue;
      out.push(finding(this, el, `icon-only ${el.tagName.toLowerCase()} with no hover rule / .pb-row-action`));
    }
    return out;
  },
};

// --- Icon button: no tooltip (§7) ------------------------------------------

const iconButtonNoTooltip: SlopRule = {
  id: 'icon-button-no-tooltip',
  part: '§7',
  severity: 'warn',
  description:
    '§7: every icon-only button gets the shared Tooltip — needs aria-describedby / data-slot="tooltip-trigger" (menu-row title exempt).',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!isIconOnlyButton(el)) continue;
      if (el.hasAttribute('aria-describedby')) continue;
      if (el.getAttribute('data-slot') === 'tooltip-trigger' || el.closest('[data-slot="tooltip-trigger"]')) continue;
      if (el.closest('[role="menuitem"]') && el.hasAttribute('title')) continue; // menu row hint exemption
      out.push(finding(this, el, `icon-only ${el.tagName.toLowerCase()} with no tooltip trigger / aria-describedby`));
    }
    return out;
  },
};

// --- Scrolling group (§0–§2) -----------------------------------------------

const unvirtualizedScroller: SlopRule = {
  id: 'unvirtualized-scroller',
  part: '§0',
  severity: 'error',
  description:
    '§0: every dynamic-length scrolling list virtualizes — a tall scroller with 60+ direct children is unvirtualized.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const cs = ctx.css(el);
      const scrolls = [cs.overflowY, cs.overflowX, cs.overflow].some((o) => o === 'auto' || o === 'scroll');
      if (!scrolls) continue;
      if (el.scrollHeight <= 2 * el.clientHeight) continue;
      const childEls = el.children.length;
      if (childEls <= 60) continue;
      out.push(finding(this, el, `${childEls} direct children, scrollHeight ${el.scrollHeight} > 2×clientHeight ${el.clientHeight}`));
    }
    return out;
  },
};

const scrollNoFade: SlopRule = {
  id: 'scroll-no-fade',
  part: '§1',
  severity: 'warn',
  description:
    '§1: a horizontal scroller needs a truthful scroll fade — no scroll-fade-x/scroll-fade-x-js class and no mask-image.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (el.scrollWidth <= el.clientWidth + 8) continue; // not horizontally overflowing
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/scroll-fade-x(-js)?/.test(cls)) continue;
      if (maskImageOf(el, ctx.css(el))) continue;
      out.push(finding(this, el, `horizontal scroller (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}) with no fade`));
    }
    return out;
  },
};

const phantomFade: SlopRule = {
  id: 'phantom-fade',
  part: '§1',
  severity: 'warn',
  description:
    '§1: a fade must NEVER paint when nothing is hidden — mask-image present but scrollWidth ≤ clientWidth (the fade lies).',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!maskImageOf(el, ctx.css(el))) continue;
      if (el.scrollWidth > el.clientWidth) continue; // legitimately hiding content
      out.push(finding(this, el, `mask-image fade but scrollWidth ${el.scrollWidth} ≤ clientWidth ${el.clientWidth}`));
    }
    return out;
  },
};

const scrollbarFlush: SlopRule = {
  id: 'scrollbar-flush',
  part: 'Part 5',
  severity: 'warn',
  description:
    'Part 5: scrollables carry asymmetric right padding so content clears the scrollbar — padding-right < 8px while overflowing vertically with content reaching the right edge.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const cs = ctx.css(el);
      const scrollsY = [cs.overflowY, cs.overflow].some((o) => o === 'auto' || o === 'scroll');
      if (!scrollsY) continue;
      if (el.scrollHeight <= el.clientHeight) continue; // not overflowing
      const pr = parseFloat(cs.paddingRight) || 0;
      if (pr >= 8) continue;
      // content reaching within 4px of the right edge
      const box = rectOf(el);
      const reachesEdge = Array.from(el.children).some((c) => {
        const cr = rectOf(c);
        return box.right - cr.right <= 4;
      });
      if (!reachesEdge) continue;
      out.push(finding(this, el, `padding-right ${pr}px (<8px) with content flush to the scrollbar`));
    }
    return out;
  },
};

// --- Typography & tokens (Part 5) ------------------------------------------

const FONT_ALLOW = /^("?(Geist|Geist Mono)"?|ui-monospace|ui-sans-serif|-apple-system|system-ui)/i;

const fontFamily: SlopRule = {
  id: 'font-family',
  part: 'Part 5',
  severity: 'warn',
  description:
    'Part 5: Geist / Geist Mono ONLY — computed font-family does not start with the Geist / ui-monospace fallback chain.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      // Only grade elements that render text directly.
      if (!hasDirectText(el)) continue;
      const ff = ctx.css(el).fontFamily;
      if (!ff) continue;
      if (FONT_ALLOW.test(ff.trim())) continue;
      out.push(finding(this, el, `font-family: ${ff}`));
    }
    return out;
  },
};

const uppercaseLabel: SlopRule = {
  id: 'uppercase-label',
  part: '§25',
  severity: 'error',
  description:
    '§25: group/section labels are sentence-case — never uppercase (text-transform: uppercase on small <13px text).',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!hasDirectText(el)) continue;
      const cs = ctx.css(el);
      if (cs.textTransform !== 'uppercase') continue;
      const size = parseFloat(cs.fontSize) || 0;
      if (size >= 13) continue;
      out.push(finding(this, el, `text-transform: uppercase at ${cs.fontSize}`));
    }
    return out;
  },
};

const hardcodedStatusHex: SlopRule = {
  id: 'hardcoded-status-hex',
  part: 'Part 5',
  severity: 'warn',
  description:
    'Part 5: raw hex only for the status trio (#50E3C2/#EE0000/#F5A623) — a saturated non-token color on small UI text.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!hasDirectText(el)) continue;
      const inline = el.getAttribute('style') ?? '';
      const hexInInline = inline.match(/#[0-9a-fA-F]{6}/g) ?? [];
      const cs = ctx.css(el);
      const size = parseFloat(cs.fontSize) || 0;
      if (size >= 16) continue; // "small UI text"
      // Inline hard hexes not in the trio.
      for (const hx of hexInInline) {
        if (!STATUS_TRIO.has(hx.toLowerCase())) {
          out.push(finding(this, el, `hardcoded ${hx} (not the brand status trio)`));
        }
      }
      // Computed color: only flag clearly saturated, non-neutral colors.
      const tuple = rgbTuple(cs.color);
      if (tuple && hexInInline.length === 0) {
        const [r, g, b] = tuple.split(',').map((n) => parseFloat(n));
        if (Number.isFinite(r) && isSaturated(r, g, b)) {
          out.push(finding(this, el, `saturated non-token color ${cs.color} on small UI text`));
        }
      }
    }
    return out;
  },
};

const editorShadow: SlopRule = {
  id: 'editor-shadow',
  part: 'Part 5',
  severity: 'error',
  description:
    'Part 5: editor surfaces are FLAT — box-shadow that is not a 0.5px hairline ring / approved popover/card/input token shadow.',
  check(ctx) {
    const out: SlopFinding[] = [];
    const inEditor =
      !!(ctx.root as Document).querySelector?.('[data-editor-surface]') ||
      (typeof location !== 'undefined' && /\/editor\//.test(location.pathname));
    if (!inEditor) return out;
    for (const el of ctx.els) {
      if (!el.closest('[data-editor-surface]') && !/\/editor\//.test(typeof location !== 'undefined' ? location.pathname : '')) continue;
      const sh = ctx.css(el).boxShadow;
      if (!sh || sh === 'none') continue;
      if (isHairlineRing(sh)) continue;
      out.push(finding(this, el, `box-shadow: ${sh}`));
    }
    return out;
  },
};

// --- Layout shift & clipping (§13, §24, Part 10) ---------------------------

const focusringClip: SlopRule = {
  id: 'focusring-clip',
  part: '§24',
  severity: 'warn',
  description:
    '§24/Part 5: focus rings never clip — a focusable element whose nearest overflow-hidden ancestor sits <4px from its border box.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!el.matches(INTERACTIVE_SEL) && el.getAttribute('tabindex') == null) continue;
      // nearest overflow-hidden ancestor
      let clip: Element | null = el.parentElement;
      while (clip) {
        const co = ctx.css(clip);
        if ([co.overflow, co.overflowX, co.overflowY].some((o) => o === 'hidden')) break;
        clip = clip.parentElement;
      }
      if (!clip) continue;
      const eb = rectOf(el);
      const cb = rectOf(clip);
      if (eb.width === 0 && eb.height === 0) continue; // no layout (test env w/o stub)
      const gap = Math.min(eb.left - cb.left, cb.right - eb.right, eb.top - cb.top, cb.bottom - eb.bottom);
      if (gap >= 4) continue;
      out.push(finding(this, el, `overflow-hidden ancestor ${gap.toFixed(1)}px from border box — focus ring will clip`));
    }
    return out;
  },
};

const fixedWidthInPane: SlopRule = {
  id: 'fixed-width-in-pane',
  part: '§24',
  severity: 'warn',
  description:
    '§24: no fixed field widths in resizable panes — w-[Npx] (N ≥ 200) inside a [data-panel] / flex-basis sibling clips at the pane edge.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const inPane = !!el.closest('[data-panel]');
      if (!inPane) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      const inline = el.getAttribute('style') ?? '';
      // hard px width from a w-[Npx] utility or inline width
      const m = cls.match(/w-\[(\d+)px\]/) ?? inline.match(/(?:^|;|\s)width\s*:\s*(\d+)px/);
      if (!m) continue;
      const n = parseFloat(m[1]);
      if (n < 200) continue;
      out.push(finding(this, el, `fixed width ${n}px inside a resizable pane — use w-full max-w-[${n}px]`));
    }
    return out;
  },
};

// --- Menus (§21) -----------------------------------------------------------

const menuIconsAllOrNone: SlopRule = {
  id: 'menu-icons-all-or-none',
  part: '§21',
  severity: 'error',
  description:
    '§21: within one menu ALL items carry a leading icon or NONE do — a mixed set reads broken.',
  check(ctx) {
    const out: SlopFinding[] = [];
    const menus = Array.from((ctx.root as ParentNode).querySelectorAll('[role="menu"]'));
    for (const menu of menus) {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      if (items.length < 2) continue;
      const withIcon = items.filter((it) => it.querySelector('svg')).length;
      if (withIcon === 0 || withIcon === items.length) continue;
      out.push(finding(this, menu, `${withIcon}/${items.length} menu items have a leading icon`));
    }
    return out;
  },
};

const menuIconMixedWeight: SlopRule = {
  id: 'menu-icon-mixed-weight',
  part: '§21',
  severity: 'warn',
  description:
    '§21: menu icons are ONE stroke family — some filled (fill=currentColor) and some stroke-based, or rendered sizes differing >2px, mixes two design systems.',
  check(ctx) {
    const out: SlopFinding[] = [];
    const menus = Array.from((ctx.root as ParentNode).querySelectorAll('[role="menu"]'));
    for (const menu of menus) {
      const svgs = Array.from(menu.querySelectorAll('[role="menuitem"] svg')) as SVGElement[];
      if (svgs.length < 2) continue;
      let filled = 0;
      let stroked = 0;
      const sizes: number[] = [];
      for (const svg of svgs) {
        const paths = Array.from(svg.querySelectorAll('path, circle, rect, polygon'));
        const anyFill = paths.some((p) => {
          const f = (p.getAttribute('fill') ?? '').toLowerCase();
          return f === 'currentcolor' || (f && f !== 'none');
        });
        if (anyFill) filled++;
        else stroked++;
        const r = rectOf(svg);
        sizes.push(Math.max(r.width, r.height));
      }
      const maxSize = Math.max(...sizes);
      const minSize = Math.min(...sizes);
      const mixedWeight = filled > 0 && stroked > 0;
      const mixedSize = maxSize > 0 && maxSize - minSize > 2;
      if (!mixedWeight && !mixedSize) continue;
      out.push(
        finding(
          this,
          menu,
          mixedWeight
            ? `${filled} filled + ${stroked} stroke-based icons in one menu`
            : `icon sizes differ by ${(maxSize - minSize).toFixed(1)}px`,
        ),
      );
    }
    return out;
  },
};

// --- Selection / cursor (Part 5) -------------------------------------------

const chromeSelectable: SlopRule = {
  id: 'chrome-selectable',
  part: 'Part 5',
  severity: 'warn',
  description:
    'Part 5: chrome (rails/pills/tabs) is select-none — a rail/pill/tab without user-select:none.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const isChrome =
        el.matches('[role="tab"]') ||
        !!el.closest('[role="tablist"], [data-rail], nav') ||
        /\bpill\b/.test(typeof el.className === 'string' ? el.className : '');
      if (!isChrome) continue;
      const us = ctx.css(el).userSelect || (ctx.css(el) as unknown as { webkitUserSelect?: string }).webkitUserSelect;
      if (us === 'none') continue;
      out.push(finding(this, el, `chrome element without user-select:none (user-select: ${us || 'auto'})`));
    }
    return out;
  },
};

const cursorMismatch: SlopRule = {
  id: 'cursor-mismatch',
  part: 'Part 5',
  severity: 'warn',
  description:
    'Part 5: cursor semantics — buttons get pointer, static text gets default. A button with cursor:text, or static text with cursor:pointer and no interactive ancestor.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const cursor = ctx.css(el).cursor;
      // (a) button / [role=button] showing a text caret.
      if (el.matches('button, [role="button"]') && cursor === 'text') {
        out.push(finding(this, el, `interactive control with cursor:text`));
        continue;
      }
      // (b) static text carrying pointer with NO interactive ancestor.
      if (cursor === 'pointer' && el.matches('p, h1, h2, h3, h4, h5, h6, span, label')) {
        if (el.closest('button, a, [role="button"], [onclick]')) continue; // legit — clickable ancestor
        if (el.matches('button, a, [role="button"]')) continue;
        out.push(finding(this, el, `static ${el.tagName.toLowerCase()} with cursor:pointer and no interactive ancestor`));
      }
    }
    return out;
  },
};

// --- §42 transition group --------------------------------------------------

function transitionPropsOf(cs: CSSStyleDeclaration): string[] {
  const props = cs.transitionProperty.split(',').map((p) => p.trim()).filter(Boolean);
  // `transition-property: none` = no transition ever runs, whatever the
  // duration/easing say — the §42 rules must treat it as clean.
  if (props.length === 1 && props[0] === 'none') return [];
  return props;
}

const transitionAll: SlopRule = {
  id: 'transition-all',
  part: '§42',
  severity: 'error',
  description:
    '§42: never transition-all — scope to what changes (transition-colors / transition-[transform,...]).',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!el.matches(INTERACTIVE_SEL)) continue;
      const props = transitionPropsOf(ctx.css(el));
      if (!props.includes('all')) continue;
      if (isIntentionalMotion(el, props)) continue;
      out.push(finding(this, el, `transition-property: all`));
    }
    return out;
  },
};

const transitionPaintProp: SlopRule = {
  id: 'transition-paint-prop',
  part: '§42',
  severity: 'error',
  description:
    '§42: never transition layout/paint props (box-shadow, width, height, top/left, margin, padding) — they reflow/repaint every frame; focus rings SNAP, shadows animate a pseudo-element opacity.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      const props = transitionPropsOf(ctx.css(el));
      const jank = jankPropsOf(props).filter((p) => p !== 'all (includes layout/paint props)');
      if (jank.length === 0) continue; // `all` is covered by transition-all
      if (isIntentionalMotion(el, props)) continue;
      out.push(finding(this, el, `transitions layout/paint props: ${jank.join(', ')}`));
    }
    return out;
  },
};

const transitionTooSlow: SlopRule = {
  id: 'transition-too-slow',
  part: '§42',
  severity: 'error',
  description:
    '§42: interaction feedback is ≤100ms (duration-75 for small controls) — the 100ms theme default is fine; an explicit duration-150+ crept in.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!el.matches(INTERACTIVE_SEL)) continue;
      const cs = ctx.css(el);
      const props = transitionPropsOf(cs);
      if (props.length === 0) continue; // transition-property: none — inert
      if (isIntentionalMotion(el, props)) continue;
      const durations = parseMs(cs.transitionDuration);
      const worst = Math.max(0, ...durations);
      if (worst <= 100) continue; // 100ms default is compliant
      out.push(finding(this, el, `transition-duration ${worst}ms (>100ms) on [${props.join(', ')}]`));
    }
    return out;
  },
};

const easeInFeedback: SlopRule = {
  id: 'ease-in-feedback',
  part: '§42',
  severity: 'warn',
  description:
    '§42: house curve is cubic-bezier(.2,0,.1,1) ease-out — never ease-in / ease-in-out (or an ease-in-shaped bezier) on feedback.',
  check(ctx) {
    const out: SlopFinding[] = [];
    for (const el of ctx.els) {
      if (!el.matches(INTERACTIVE_SEL)) continue;
      const cs = ctx.css(el);
      const props = transitionPropsOf(cs);
      if (props.length === 0) continue; // transition-property: none — inert
      if (isIntentionalMotion(el, props)) continue;
      const bad = easingViolation(cs.transitionTimingFunction);
      if (!bad) continue;
      out.push(finding(this, el, `transition-timing-function: ${bad}`));
    }
    return out;
  },
};

const pressInstantRuleMissing: SlopRule = {
  id: 'press-instant-rule-missing',
  part: '§42',
  severity: 'error',
  description:
    '§42: the global press-instant rule (globals.css) must exist — `button:active{transition-duration:0s}` (or transition:none). Absent = press feedback animates instead of snapping.',
  check(ctx) {
    // PAGE-LEVEL: one finding max, not per element.
    const doc = (ctx.root as Document).styleSheets ? (ctx.root as Document) : document;
    let found = false;
    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (found) return;
        const grouping = rule as CSSGroupingRule;
        if (grouping.cssRules && grouping.cssRules.length) {
          visit(grouping.cssRules);
          continue;
        }
        const style = rule as CSSStyleRule;
        const sel = style.selectorText;
        if (!sel) continue;
        // §42 accepts button:active OR any :active on the role list.
        const isActiveOnRole =
          /:active\b/.test(sel) &&
          /(^|[\s,])(button|a|\[role=("|')?(button|tab|menuitem|option)("|')?\])/i.test(sel);
        if (!isActiveOnRole) continue;
        try {
          const dur = style.style.transitionDuration;
          const whole = style.style.transition;
          if (dur === '0s' || /(^|\s)none(\s|$)/.test(whole) || /\b0s\b/.test(whole)) {
            found = true;
            return;
          }
        } catch {
          /* ignore */
        }
      }
    };
    try {
      for (const sheet of Array.from(doc.styleSheets)) {
        if (found) break;
        try {
          visit(sheet.cssRules);
        } catch {
          /* cross-origin — skip silently */
        }
      }
    } catch {
      /* no styleSheets — treat as missing */
    }
    if (found) return [];
    const anchor = (ctx.root as Document).documentElement ?? ctx.els[0] ?? document.documentElement;
    return [finding(this, anchor, 'no `button:active { transition-duration: 0s }` rule on this page')];
  },
};

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

const RULES: SlopRule[] = [
  radiusVocabulary,
  rowRadiusToken,
  activeFillToken,
  inlineStyleState,
  iconButtonNoHover,
  iconButtonNoTooltip,
  unvirtualizedScroller,
  scrollNoFade,
  phantomFade,
  scrollbarFlush,
  fontFamily,
  uppercaseLabel,
  hardcodedStatusHex,
  editorShadow,
  focusringClip,
  fixedWidthInPane,
  menuIconsAllOrNone,
  menuIconMixedWeight,
  chromeSelectable,
  cursorMismatch,
  transitionAll,
  transitionPaintProp,
  transitionTooSlow,
  easeInFeedback,
  pressInstantRuleMissing,
];

// Test seam: allow injecting a broken rule (spec test 14) without exporting
// the whole registry as mutable API.
let extraRules: SlopRule[] = [];
export function __setExtraRulesForTest(rules: SlopRule[]): void {
  extraRules = rules;
}

// ---------------------------------------------------------------------------
// Small helper predicates
// ---------------------------------------------------------------------------

/** Does this element render its OWN text (not just descendants)? Grades a
    text-owning leaf, so font/uppercase/color rules don't fire on wrappers. */
function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* text */ && (node.textContent ?? '').trim().length > 0) return true;
  }
  return false;
}

/** Saturated, clearly non-neutral color heuristic (for hardcoded-status-hex). */
function isSaturated(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 40) return false; // near-black text — neutral
  return max - min > 60; // wide channel spread = a real color, not a gray
}

/** A 0.5px hairline ring or a 0-blur inset ring — the approved "flat" shadows. */
function isHairlineRing(shadow: string): boolean {
  // "0 0 0 0.5px ..." or spreads ≤ 0.5px with 0 blur, incl. token-resolved.
  if (/\b0px\s+0px\s+0px\s+0?\.?5px\b/.test(shadow)) return true;
  if (/\b0px?\s+0px?\s+0px?\s+0?\.?5px\b/.test(shadow)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// runSlopScan — one walk, cached css, every rule isolated
// ---------------------------------------------------------------------------

export function runSlopScan(root: ParentNode = typeof document !== 'undefined' ? document : ({} as ParentNode)): SlopFinding[] {
  const cache = new Map<Element, CSSStyleDeclaration>();
  const css = (el: Element): CSSStyleDeclaration => {
    let cs = cache.get(el);
    if (!cs) {
      cs = getComputedStyle(el);
      cache.set(el, cs);
    }
    return cs;
  };
  getComputedStyleCached = css; // let scrollAncestor reuse the cache

  // Single walk. Skip our own panel subtree and cheaply-invisible elements.
  const all = Array.from(root.querySelectorAll('*'));
  const els: Element[] = [];
  const docEl = (root as Document).documentElement ?? null;
  const bodyEl = (root as Document).body ?? null;
  for (const el of all) {
    // Page chrome owned by tooling, never by the app: <html>/<body> carry the
    // panel's own DevTools-dock margin transition (the cssSlowdown v0.23.1
    // self-report lesson), and browser-agent overlays are not the app either.
    if (el === docEl || el === bodyEl) continue;
    if (el.closest('#linear-grab-root, #claude-agent-glow-border, [id^="react-scan"]')) continue; // never scan devtools
    // Performance guard: skip invisible leaf elements early. An element with
    // no box AND no children is inert. Rules that read layout do so via plain
    // property access, so a test's stubbed rect keeps the element in.
    const r = rectOf(el);
    if (r.width === 0 && r.height === 0 && el.children.length === 0) {
      // Keep it only if a rule needs it despite zero rect — but leaves with no
      // box and no children never carry a finding, so dropping is safe.
      // (Elements WITH children are kept: menus/scrollers may be stubbed.)
      continue;
    }
    els.push(el);
  }

  const ctx: ScanContext = { root, els, css };
  const findings: SlopFinding[] = [];
  for (const rule of [...RULES, ...extraRules]) {
    try {
      findings.push(...rule.check(ctx));
    } catch {
      /* a broken rule is skipped — every other rule still reports (test 14) */
    }
  }

  getComputedStyleCached = (el) => getComputedStyle(el); // reset the module pointer
  return findings;
}

// ---------------------------------------------------------------------------
// Report + agent prompt
// ---------------------------------------------------------------------------

/** Markdown report grouped by ruleId. Deterministic ordering: errors first,
    then by finding count descending, then ruleId — so the same page always
    produces the same report (snapshot-stable). */
export function formatSlopReport(findings: SlopFinding[]): string {
  const groups = new Map<string, SlopFinding[]>();
  for (const f of findings) {
    const arr = groups.get(f.ruleId);
    if (arr) arr.push(f);
    else groups.set(f.ruleId, [f]);
  }

  const ordered = Array.from(groups.entries()).sort((a, b) => {
    const sevA = a[1][0].severity === 'error' ? 0 : 1;
    const sevB = b[1][0].severity === 'error' ? 0 : 1;
    if (sevA !== sevB) return sevA - sevB; // errors first
    if (b[1].length !== a[1].length) return b[1].length - a[1].length; // count desc
    return a[0].localeCompare(b[0]); // stable tiebreak
  });

  const total = findings.length;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const multiPage = new Set(findings.map((f) => f.page).filter(Boolean)).size > 1;
  const lines = [`# Slop scan — ${errors} error${errors === 1 ? '' : 's'}, ${total - errors} warn (${total} total)`, ''];
  for (const [ruleId, group] of ordered) {
    const f0 = group[0];
    lines.push(`## ${ruleId} — ${f0.severity} ×${group.length} [${f0.part}]`);
    lines.push(f0.description);
    for (const f of group) {
      lines.push(`- ${multiPage && f.page ? `\`${f.page}\` ` : ''}\`${f.selector}\` — ${f.evidence}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** The report wrapped in ready-to-paste agent instructions — fix at the
    token/variant level, cite the §ids, keep intentional motion, re-scan to
    prove zero errors. Modeled on cssSlowdownPrompt. */
export function slopScanPrompt(findings: SlopFinding[]): string {
  return [
    'Below is a design-system SLOP report from my running app — each finding is a',
    'live-DOM violation of the Linear/Protocolbase primitives contract (`Linear',
    "-primitives.md`). Every rule cites its §id. Goal: zero errors. Rules:",
    '',
    '1. Fix at the TOKEN / VARIANT level, not the call sites. Most of these come',
    '   from shared row/button/menu variants — change --row-radius, --selected,',
    '   .pb-row-action, the Button/Input variant, or the globals.css §42 rules —',
    '   not one component at a time.',
    '2. Cite the primitives §id in your fix (each finding carries it). Radius →',
    '   §40 vocabulary {8,12,16,full}; active fill → §11 var(--selected); menus →',
    '   §21 all-or-none icons + one stroke family; uppercase labels → §25;',
    '   editor flatness → Part 5; scrollers → §0–1 virtualize + truthful fade.',
    '3. §42 group (transition-all / paint-prop / too-slow / ease-in / press-',
    '   instant): scope transitions to what changes, drop box-shadow/width/height',
    '   from transition lists, keep feedback ≤100ms (duration-75 small controls),',
    '   use ease-out (cubic-bezier(.2,0,.1,1)), and keep the global',
    '   `button:active{transition-duration:0s}` press-instant rule.',
    '4. Do NOT touch EXEMPT intentional motion — popover/menu/dialog entry-exit,',
    '   svg icon micro-motion, and panel width/height transitions are §42-blessed.',
    '   The scan already excludes them; do not "fix" them.',
    "5. 'unverifiable' warnings mean the token collapsed to the anti-pattern this",
    '   theme — verify the intent in BOTH themes, do not just silence it.',
    '6. PROOF REQUIRED: after the change I will re-run the scan — it must show 0',
    '   errors. State what you changed per token/variant; do not claim done blind.',
    '',
    '---',
    '',
    formatSlopReport(findings),
  ].join('\n');
}
