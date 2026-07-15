/**
 * Shared CSS-contract primitives — the pure kernel behind BOTH auditors.
 *
 * `cssSlowdown.ts` (live/timing engine) and `slopScan.ts` (design-drift
 * engine) both grade transitions against Linear-primitives §42. If each kept
 * its own copy of "what is a jank prop" / "what easing is banned" / "what
 * motion is intentional", the two would silently drift and start contradicting
 * each other. So every predicate that BOTH need lives here, once.
 *
 * HARD CONSTRAINT: this module is pure and SSR-safe. Zero imports, no side
 * effects, and it NEVER touches window/document at module top level — it is
 * imported by the extension's content world where the module graph is
 * evaluated before the panel decides whether the DOM is real. All DOM access
 * is inside functions that receive an Element, so a caller in a headless test
 * can drive it with a fixture.
 */

// ---------------------------------------------------------------------------
// Duration / delay parsing
// ---------------------------------------------------------------------------

/** Split a computed `transition-duration`/`-delay` list into a ms array.
    Handles the `s` vs `ms` unit and the comma-separated multi-value form. */
export function parseMs(value: string): number[] {
  return value.split(',').map((v) => {
    const t = v.trim();
    if (t.endsWith('ms')) return parseFloat(t) || 0;
    if (t.endsWith('s')) return (parseFloat(t) || 0) * 1000;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Jank props — layout/paint properties that reflow or repaint every frame
// ---------------------------------------------------------------------------

/** Properties that reflow (layout) or repaint every animated frame — the
    animations skill's / §42's "animate transform and opacity ONLY" rule.
    Transitioning any of these makes focus rings SNAP-repaint and shadows
    thrash instead of compositing. */
export const LAYOUT_PAINT_PROPS = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'top', 'left', 'right', 'bottom', 'inset',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font-size', 'line-height', 'letter-spacing',
  'box-shadow', 'filter', 'background-position',
  'grid-template-columns', 'grid-template-rows', 'flex-basis', 'gap',
]);

/** Which of the given transitioned props are jank props. `all` implies the
    whole set, so it is reported as one umbrella entry. */
export function jankPropsOf(properties: string[]): string[] {
  if (properties.includes('all')) return ['all (includes layout/paint props)'];
  return properties.filter((p) => LAYOUT_PAINT_PROPS.has(p));
}

// ---------------------------------------------------------------------------
// Easing — §42 bans ease-in AND ease-in-out on feedback
// ---------------------------------------------------------------------------

/** "Never ease-in (or ease-in-out) for UI feedback" (§42 / Emil) — an
    ease-in curve delays the start exactly when the user is watching. Returns
    the offending timing string, or null when the curve is acceptable.
    Bezier heuristic: an ease-in-shaped curve pushes its first control point
    right (x1 ≥ 0.4) while keeping it low (y1 < x1/2). */
export function easingViolation(timing: string): string | null {
  const first = firstTimingFunction(timing);
  if (first === 'ease-in' || first === 'ease-in-out') return first;
  const m = first.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*(-?[\d.]+)/);
  if (m) {
    const x1 = parseFloat(m[1]);
    const y1 = parseFloat(m[2]);
    if (x1 >= 0.4 && y1 < x1 / 2) return first;
  }
  return null;
}

/** First entry of a comma-separated timing-function list, WITHOUT splitting a
    `cubic-bezier(a, b, c, d)` apart at its inner commas (paren depth aware). */
function firstTimingFunction(timing: string): string {
  let depth = 0;
  for (let i = 0; i < timing.length; i++) {
    const ch = timing[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return timing.slice(0, i).trim();
  }
  return timing.trim();
}

// ---------------------------------------------------------------------------
// Intentional-motion exemption — §42 marks these subtrees "do NOT strip"
// ---------------------------------------------------------------------------

const INTENTIONAL_CONTENT_SEL =
  '[data-slot*="content"], [role="menu"], [role="dialog"], [role="listbox"]';
/** Panels may legitimately animate their SIZE (resize choreography) — but
    ONLY size. A panel transitioning color/shadow is still slop. */
const PANEL_SIZE_PROPS = new Set([
  'width', 'height', 'flex-basis',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
]);

/**
 * §42 exemption predicate: is this element's transition intentional motion?
 *
 * True when the element is (or is inside) an svg icon (chevron micro-motion),
 * OR sits inside a popover/menu/dialog/listbox CONTENT subtree (entry/exit
 * choreography). Those cases exempt EVERYTHING.
 *
 * The [data-panel] case is narrower: panel motion is only intentional for
 * SIZE. When `props` is supplied and the element is inside a [data-panel],
 * it is exempt ONLY if every transitioned prop is a size prop
 * (width/height/flex-basis/grid-template-*); a panel animating anything else
 * is not exempt.
 *
 * `closest` can throw on a detached/foreign node, so every call is guarded.
 */
export function isIntentionalMotion(el: Element, props?: string[]): boolean {
  // svg icon micro-motion — target is an <svg> or lives inside one.
  if (el instanceof SVGElement) return true;
  try {
    if (el.closest('svg')) return true;
  } catch {
    /* detached / foreign node — fall through */
  }

  // Popover / menu / dialog / listbox content — exempt everything.
  try {
    if (el.closest(INTENTIONAL_CONTENT_SEL)) return true;
  } catch {
    /* ignore */
  }

  // Resizable pane — exempt ONLY size transitions.
  try {
    if (el.closest('[data-panel]')) {
      if (!props || props.length === 0) return true; // no prop info → treat as panel motion
      return props.every((p) => PANEL_SIZE_PROPS.has(p));
    }
  } catch {
    /* ignore */
  }

  return false;
}

// ---------------------------------------------------------------------------
// Element selector — short, mostly-unique CSS path for reports
// ---------------------------------------------------------------------------

/** tag#id.class — a short human-readable selector for a finding. Caps at two
    classes so a utility-class soup element doesn't produce a wall of text. */
export function elementSelector(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className
      ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
      : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}
