/**
 * CSS slowdown detection — the lag react-scan CANNOT see.
 *
 * react-scan measures React render time; a `transition-duration: 150ms` (or a
 * transition-delay) plays AFTER React committed, so an interaction can be
 * render-fast and still FEEL slow. Two engines:
 *
 *  1. Live watcher (always on, event-driven, ~zero cost): `transitionrun`
 *     fires whenever a transition actually starts. If one starts within
 *     ~200ms of a pointer/keyboard input, the user's feedback is being
 *     ANIMATED — that is a CSS slowdown, recorded with component + file:line
 *     (react-grab fiber source) and pushed to the bridge's scan log
 *     (`.lineargrab/scan.ndjson`, kind "css-slowdown") for agents.
 *
 *  2. Audit sweep (on demand): walk visible interactive elements and flag
 *     every transition ≥ the threshold before anyone even clicks — the
 *     "find all 150ms buttons" pass.
 */

import { bridgeBase } from './bridge';
import {
  easingViolation,
  elementSelector,
  isIntentionalMotion,
  jankPropsOf,
  parseMs,
} from './cssShared';

export interface CssSlowdownFinding {
  /** 'live' = caught after real input; 'audit' = static sweep. */
  mode: 'live' | 'audit';
  page: string;
  /** tag#id.class selector of the element. */
  element: string;
  /** React component display name when resolvable. */
  component?: string | null;
  /** file:line of the component (react-grab fiber source). */
  source?: string | null;
  /** Properties being transitioned (live: the one that fired). */
  properties: string[];
  durationMs: number;
  delayMs: number;
  /** live only: ms between the input and the transition starting. */
  sinceInputMs?: number;
  /** How many identical elements share this finding (audit grouping). */
  count: number;
  /** The class(es) most likely responsible, for a targeted fix. */
  classHint?: string;
  /** Timing function, when it violates the easing rules (ease-in / ease-in-out on UI). */
  easing?: string;
  /** Transitioned properties that reflow/repaint every frame. */
  jankProps?: string[];
  suggestion: string;
  at: number;
}

/**
 * §42 house default = 100ms ease-out; only ABOVE it is slop. `duration+delay`
 * that lands exactly on the blessed 100ms control must produce NO finding — so
 * the flag condition is strictly-greater-than this value (see the `> ` checks
 * below), and a compliant `transition-*` (which inherits the 100ms default)
 * never trips. Suggestions still nudge toward `duration-75` for small controls.
 */
export const SLOWDOWN_THRESHOLD_MS = 100;
/** A transition starting this soon after input = input feedback animating. */
const INPUT_WINDOW_MS = 200;

// ---------------------------------------------------------------------------
// Shared helpers — parseMs / elementSelector / jankPropsOf / easingViolation /
// isIntentionalMotion all live in cssShared.ts so slopScan can't drift from us.
// ---------------------------------------------------------------------------

/** The classes worth blaming — transition-* utilities and duration/delay. */
function classHintFor(el: Element): string | undefined {
  if (typeof el.className !== 'string') return undefined;
  const hits = el.className
    .split(/\s+/)
    .filter((c) => /^(transition|duration-|delay-|ease-)/.test(c));
  return hits.length ? hits.join(' ') : undefined;
}

function suggestionFor(
  properties: string[],
  durationMs: number,
  delayMs: number,
  classHint?: string,
  easing?: string | null,
  jank?: string[],
): string {
  const bits: string[] = [];
  if (delayMs > 0) bits.push(`remove the ${Math.round(delayMs)}ms transition-delay`);
  if (classHint?.includes('transition-all') || properties.includes('all')) {
    bits.push("scope 'transition-all' to the intended properties (e.g. transition-colors)");
  }
  if (jank?.length) {
    bits.push(
      `JANK: transitions LAYOUT/PAINT props (${jank.join(', ')}) — reflow/repaint every frame; animate transform/opacity instead (box-shadow → animate a pseudo-element's opacity)`,
    );
  }
  if (easing) bits.push(`easing '${easing}' starts slow — §42 bans ease-in/ease-in-out on UI, use ease-out`);
  if (durationMs > 500) bits.push(`${Math.round(durationMs)}ms is over the 500ms HARD CAP for UI feedback`);
  else if (durationMs > 300) bits.push(`${Math.round(durationMs)}ms is over the 300ms UI cap`);
  else if (durationMs > 100) bits.push(`shorten ${Math.round(durationMs)}ms → ≤100ms`);
  bits.push("make PRESS feedback instant: 'active:transition-none' (and data-[state=…]:transition-none for toggles) — animate only hover in/out");
  return bits.join('; ');
}

type GrabApi = {
  getDisplayName?: (el: Element) => string | null;
  getSource?: (el: Element) => Promise<{ filePath?: string | null; lineNumber?: number | null } | null>;
};
async function grabApi(): Promise<GrabApi | null> {
  try {
    const rg = await import('react-grab');
    return (rg.getGlobalApi() as GrabApi | null) ?? null;
  } catch {
    return null;
  }
}

async function attribute(el: Element): Promise<{ component: string | null; source: string | null }> {
  const api = await grabApi();
  let component: string | null = null;
  let source: string | null = null;
  try {
    component = api?.getDisplayName?.(el) ?? null;
  } catch {
    /* fiber walk mid-render */
  }
  try {
    const s = await api?.getSource?.(el);
    if (s?.filePath) source = `${s.filePath}${s.lineNumber != null ? `:${s.lineNumber}` : ''}`;
  } catch {
    /* no debug source in prod builds */
  }
  return { component, source };
}

// ---------------------------------------------------------------------------
// Bridge push — same log react-scan writes; agents already read it.
// ---------------------------------------------------------------------------

let queue: CssSlowdownFinding[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function pushToBridge(finding: CssSlowdownFinding): void {
  queue.push(finding);
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    const events = queue.slice(0, 50).map((f) => ({ kind: 'css-slowdown', ...f }));
    queue = [];
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
  }, 1500);
}

// ---------------------------------------------------------------------------
// Findings store (panel subscribes; capped ring buffer)
// ---------------------------------------------------------------------------

let findings: CssSlowdownFinding[] = [];
const subs = new Set<(f: CssSlowdownFinding[]) => void>();
function addFinding(f: CssSlowdownFinding): void {
  // Identical repeat hits (same element, classes, properties) merge into one
  // finding with a count — four cards for four keystrokes on the same input
  // bury the report without adding information. The bridge log still gets
  // every occurrence (it is a log).
  const twin =
    f.mode === 'live'
      ? findings.find(
          (x) =>
            x.mode === 'live' &&
            x.element === f.element &&
            (x.classHint ?? '') === (f.classHint ?? '') &&
            x.properties.join() === f.properties.join(),
        )
      : undefined;
  if (twin) {
    twin.count += 1;
    twin.at = f.at;
    twin.sinceInputMs = f.sinceInputMs;
    findings = [...findings];
  } else {
    findings = [f, ...findings].slice(0, 100);
  }
  for (const cb of subs) cb(findings);
  pushToBridge(f);
}
export function subscribeCssSlowdowns(cb: (f: CssSlowdownFinding[]) => void): () => void {
  subs.add(cb);
  cb(findings);
  return () => void subs.delete(cb);
}
export function clearCssSlowdowns(): void {
  findings = [];
  for (const cb of subs) cb(findings);
}

// ---------------------------------------------------------------------------
// Engine 1 — live watcher
// ---------------------------------------------------------------------------

// Live-capture switch — persisted; default ON. Pausing keeps the listeners
// installed but drops events, so toggling is instant and free.
let watchEnabled = true;
try {
  watchEnabled = localStorage.getItem('linear-grab:css-watch') !== '0';
} catch {
  /* storage blocked */
}
const watchSubs = new Set<(on: boolean) => void>();
export function cssWatchEnabled(): boolean {
  return watchEnabled;
}
export function setCssWatchEnabled(on: boolean): void {
  watchEnabled = on;
  try {
    localStorage.setItem('linear-grab:css-watch', on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  for (const cb of watchSubs) cb(on);
}
export function subscribeCssWatchEnabled(cb: (on: boolean) => void): () => void {
  watchSubs.add(cb);
  cb(watchEnabled);
  return () => void watchSubs.delete(cb);
}

let watching = false;
export function startCssSlowdownWatch(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;

  let lastInputAt = 0;
  const markInput = () => {
    lastInputAt = performance.now();
  };
  for (const t of ['pointerdown', 'pointerup', 'keydown'] as const) {
    window.addEventListener(t, markInput, { capture: true, passive: true });
  }

  // One finding per ELEMENT per input burst — a single click transitions
  // color + 4 border sides + background on the same button; six cards for
  // one press buries the report. Properties accumulate for 300ms, then
  // flush as one finding. Element-level cooldown stops hover storms.
  const reported = new Map<string, number>();
  const pending = new Map<
    Element,
    { props: Set<string>; duration: number; delay: number; since: number; timer: ReturnType<typeof setTimeout> }
  >();

  window.addEventListener(
    'transitionrun',
    (e: TransitionEvent) => {
      if (!watchEnabled) return; // paused from the Design tab
      const since = performance.now() - lastInputAt;
      if (since > INPUT_WINDOW_MS) return; // ambient animation, not input feedback
      const el = e.target;
      if (!(el instanceof Element) || el.closest('#linear-grab-root')) return;
      // Page-level chrome: the panel's own DevTools-style dock animates a
      // margin on <html> — never report ourselves (or any root transition).
      if (el === document.documentElement || el === document.body) return;
      if (e.propertyName.startsWith('--')) return; // custom-property noise

      const cs = getComputedStyle(el);
      const props = cs.transitionProperty.split(',').map((p) => p.trim());
      // §42: popover/menu/dialog content, svg micro-motion, and panel size
      // transitions are INTENTIONAL motion — never a slowdown finding.
      if (isIntentionalMotion(el, props)) return;
      const durations = parseMs(cs.transitionDuration);
      const delays = parseMs(cs.transitionDelay);
      const idx = Math.max(0, props.indexOf(e.propertyName));
      const duration = durations[idx % durations.length] ?? durations[0] ?? 0;
      const delay = delays[idx % delays.length] ?? delays[0] ?? 0;
      if (duration + delay <= SLOWDOWN_THRESHOLD_MS) return;

      const existing = pending.get(el);
      if (existing) {
        existing.props.add(e.propertyName);
        existing.duration = Math.max(existing.duration, duration);
        existing.delay = Math.max(existing.delay, delay);
        return;
      }
      const entry = {
        props: new Set([e.propertyName]),
        duration,
        delay,
        since,
        timer: setTimeout(() => {
          pending.delete(el);
          const key = elementSelector(el);
          const now = Date.now();
          if (now - (reported.get(key) ?? 0) < 5000) return;
          reported.set(key, now);
          const classHint = classHintFor(el);
          const propList = [...entry.props];
          const easing = el.isConnected ? easingViolation(getComputedStyle(el).transitionTimingFunction) : null;
          const jank = jankPropsOf(propList);
          void attribute(el).then(({ component, source }) => {
            addFinding({
              mode: 'live',
              page: location.pathname,
              element: key,
              component,
              source,
              properties: propList,
              durationMs: Math.round(entry.duration),
              delayMs: Math.round(entry.delay),
              sinceInputMs: Math.round(entry.since),
              count: 1,
              classHint,
              easing: easing ?? undefined,
              jankProps: jank.length ? jank : undefined,
              suggestion: suggestionFor(propList, entry.duration, entry.delay, classHint, easing, jank),
              at: now,
            });
          });
        }, 300),
      };
      pending.set(el, entry);
    },
    { capture: true, passive: true },
  );
}

// ---------------------------------------------------------------------------
// Engine 2 — audit sweep
// ---------------------------------------------------------------------------

const INTERACTIVE = 'button, a, input, select, textarea, [role], [tabindex], [data-state], [aria-expanded]';

export async function auditTransitions(): Promise<CssSlowdownFinding[]> {
  const groups = new Map<string, { finding: CssSlowdownFinding; example: Element }>();
  const els = Array.from(document.querySelectorAll(INTERACTIVE)).slice(0, 3000);

  for (const el of els) {
    if (el.closest('#linear-grab-root')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer' && !el.matches('button, a, input, select, textarea')) continue;

    const props = cs.transitionProperty.split(',').map((p) => p.trim());
    // §42 intentional-motion exemption (same predicate as the live watcher).
    if (isIntentionalMotion(el, props)) continue;
    const durations = parseMs(cs.transitionDuration);
    const delays = parseMs(cs.transitionDelay);
    const worst = Math.max(...durations, 0) + Math.max(...delays, 0);
    if (worst <= SLOWDOWN_THRESHOLD_MS) continue;

    const classHint = classHintFor(el);
    const key = `${el.tagName}|${classHint ?? props.join()}|${Math.round(worst)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.finding.count += 1;
      continue;
    }
    const easing = easingViolation(cs.transitionTimingFunction);
    const jank = jankPropsOf(props);
    groups.set(key, {
      example: el,
      finding: {
        mode: 'audit',
        page: location.pathname,
        element: elementSelector(el),
        component: null,
        source: null,
        properties: props,
        durationMs: Math.round(Math.max(...durations, 0)),
        delayMs: Math.round(Math.max(...delays, 0)),
        count: 1,
        classHint,
        easing: easing ?? undefined,
        jankProps: jank.length ? jank : undefined,
        suggestion: suggestionFor(props, Math.max(...durations, 0), Math.max(...delays, 0), classHint, easing, jank),
        at: Date.now(),
      },
    });
  }

  // Attribute each group's example element (component + file:line).
  const out: CssSlowdownFinding[] = [];
  for (const { finding, example } of groups.values()) {
    const { component, source } = await attribute(example);
    finding.component = component;
    finding.source = source;
    out.push(finding);
  }
  out.sort((a, b) => b.durationMs + b.delayMs - (a.durationMs + a.delayMs) || b.count - a.count);

  // Replace previous audit findings; keep live ones.
  findings = [...out, ...findings.filter((f) => f.mode === 'live')].slice(0, 100);
  for (const cb of subs) cb(findings);
  for (const f of out) pushToBridge(f);
  return out;
}

/** The report wrapped in ready-to-paste instructions for a coding agent —
    fix the variant definitions, keep intentional motion, prove with a re-audit. */
export function cssSlowdownPrompt(list: CssSlowdownFinding[]): string {
  return [
    'Below is a CSS-slowdown report from my running app (live-captured on real input + full-page audit).',
    'Goal: ALL interaction feedback must be instant. Rules:',
    '',
    '1. Most of these come from SHARED design-system variants — fix the VARIANT',
    "   DEFINITIONS, not the call sites. Grep for the exact class recipes in the",
    "   findings' `classes:` lines (e.g. `transition-all`, `transition-colors duration-150`).",
    '2. Press/toggle state changes get NO transition: add `active:transition-none`',
    '   and `data-[state=on]:transition-none` / `data-[state=open]:transition-none`.',
    '   Hover in/out may keep a transition but shorten it: duration-150 → duration-100',
    '   (duration-75 for small controls like tabs and icon buttons).',
    "3. Replace every `transition-all` with the scoped variant (transition-colors /",
    '   transition-transform / transition-opacity — per what actually changes).',
    '3b. Findings marked ⚠ layout/paint: NEVER transition width/height/top/left/',
    '   margin/padding/box-shadow — they reflow or repaint every frame. Use',
    "   transform: translate/scale, and animate a pseudo-element's opacity for shadows.",
    "3c. Findings marked ⚠ easing: never ease-in OR ease-in-out on UI (§42 bans",
    '   both) — replace with ease-out (house curve: cubic-bezier(.2,0,.1,1), the',
    '   theme default).',
    '3d. Press must be instant GLOBALLY: keep the unlayered §42 rule in globals.css',
    '   — `button:active, a:active, [role=button/tab/menuitem/option]:active',
    '   { transition-duration: 0s }` — so pointer-down feedback snaps and only the',
    '   release animates back. If a control still animates on press, that global',
    '   rule is missing or overridden.',
    '4. Where a finding\'s source looks like a generic fallback (one file:line repeated',
    '   for many components), locate the code by the `classes:` line instead.',
    '5. Do NOT touch entry/exit animations of popovers/menus or icon micro-motion',
    '   (chevron rotate etc.) — that is intentional; only input FEEDBACK must be instant.',
    '6. PROOF REQUIRED: after the change I will re-run the audit — it must show zero',
    '   interactive elements ≥100ms and clicking must produce no live findings.',
    '   Do not claim done without stating what you changed per variant.',
    '',
    '---',
    '',
    cssSlowdownReport(list),
  ].join('\n');
}

/** Markdown report — paste into an issue or a Claude Code session. */
export function cssSlowdownReport(list: CssSlowdownFinding[]): string {
  const lines = [
    `# CSS slowdowns on ${location.host}${location.pathname}`,
    `Threshold: ${SLOWDOWN_THRESHOLD_MS}ms (interaction feedback should be instant).`,
    '',
  ];
  for (const f of list) {
    lines.push(
      `## ${f.component ?? f.element}${f.count > 1 ? ` ×${f.count}` : ''} — ${f.durationMs}ms${f.delayMs ? ` +${f.delayMs}ms delay` : ''}`,
    );
    if (f.source) lines.push(`- source: ${f.source}`);
    lines.push(`- transitions: ${f.properties.join(', ')}`);
    if (f.classHint) lines.push(`- classes: \`${f.classHint}\``);
    if (f.jankProps?.length) lines.push(`- ⚠ layout/paint transition (reflows every frame): ${f.jankProps.join(', ')}`);
    if (f.easing) lines.push(`- ⚠ easing: ${f.easing} (§42 bans ease-in/ease-in-out — use ease-out)`);
    if (f.sinceInputMs != null) lines.push(`- fired ${f.sinceInputMs}ms after user input (live capture)`);
    lines.push(`- fix: ${f.suggestion}`, '');
  }
  return lines.join('\n');
}
