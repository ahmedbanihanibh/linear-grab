/**
 * Design genome extraction — reverse-engineer a component's design system
 * usage straight from the live DOM. Pick a dropdown/card/row, get back a
 * role-classified spec: classes, computed styles, which CSS custom-property
 * tokens the colors resolve to, and (via captureInteractionStates) the styles
 * that only exist while interacting — hover, focus, open.
 *
 * The genome is data an agent can act on ("style X like genome Y") and a
 * human can read — it is the automated version of measuring a reference app
 * by hand.
 */

export interface GenomeNode {
  /** Component display name (react-grab fiber) or tag+hints fallback. */
  label: string;
  /** How many identical siblings collapsed into this entry. */
  count: number;
  classes: string;
  /** Curated computed styles (only non-default/interesting ones). */
  styles: Record<string, string>;
  /** Color values resolved to design-token names, e.g. color → --text-dim. */
  tokens: Record<string, string>;
}

export interface GenomeState {
  /** What triggered it: hover | focus | attr:data-state=open | appeared */
  trigger: string;
  /** Which node it applies to. */
  label: string;
  /** Only the properties that CHANGED vs the base snapshot. */
  changed: Record<string, { from: string; to: string }>;
}

export interface Genome {
  title: string;
  pageUrl: string;
  extractedAt: number;
  nodes: GenomeNode[];
  states: GenomeState[];
}

/** Computed properties worth carrying — the ones that define a design. */
const STYLE_PROPS = [
  'display',
  'align-items',
  'justify-content',
  'gap',
  'padding',
  'margin',
  'width',
  'height',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'border-radius',
  'border-width',
  'border-color',
  'box-shadow',
  'opacity',
  'transform',
  'transition-property',
  'transition-duration',
] as const;

const COLOR_PROPS = new Set(['color', 'background-color', 'border-color']);

/** Values that mean "nothing set" — dropped from the genome for signal. */
const NOISE: Record<string, Set<string>> = {
  margin: new Set(['0px']),
  padding: new Set(['0px']),
  gap: new Set(['normal', '0px']),
  'box-shadow': new Set(['none']),
  transform: new Set(['none']),
  'border-width': new Set(['0px']),
  'border-radius': new Set(['0px']),
  'letter-spacing': new Set(['normal']),
  opacity: new Set(['1']),
  'transition-property': new Set(['all', 'none']),
  'transition-duration': new Set(['0s']),
  width: new Set(['auto']),
  height: new Set(['auto']),
};

// ---------------------------------------------------------------------------
// Token map: custom property name → normalized color, from same-origin CSS.
// ---------------------------------------------------------------------------

let probe: HTMLElement | null = null;
function normalizeColor(value: string): string | null {
  try {
    if (!probe) {
      probe = document.createElement('span');
      probe.setAttribute('data-linear-grab', 'true');
      probe.style.display = 'none';
      document.body.appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = value;
    if (!probe.style.color) return null;
    return getComputedStyle(probe).color;
  } catch {
    return null;
  }
}

let tokenMapCache: Map<string, string> | null = null;
/** normalized color value → token name (--foo). First writer wins so the
    most specific/latest sheet doesn't override the canonical token. */
function buildTokenMap(): Map<string, string> {
  if (tokenMapCache) return tokenMapCache;
  const map = new Map<string, string>();
  const rootStyle = getComputedStyle(document.documentElement);
  const seen = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // cross-origin sheets throw — skip them
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      if (!style) continue;
      for (let i = 0; i < style.length; i++) {
        const prop = style.item(i);
        if (!prop.startsWith('--') || seen.has(prop)) continue;
        seen.add(prop);
        // Resolve through the cascade so var() chains and theme blocks land
        // on the value actually in effect right now.
        const resolved = rootStyle.getPropertyValue(prop).trim() || style.getPropertyValue(prop).trim();
        if (!resolved || resolved.length > 80) continue;
        const norm = normalizeColor(resolved);
        if (norm && !map.has(norm)) map.set(norm, prop);
      }
    }
  }
  tokenMapCache = map;
  return map;
}

/** Public reset — theme switches change token values. */
export function resetTokenMap(): void {
  tokenMapCache = null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 && r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden';
}

function roleHints(el: Element): string {
  const bits: string[] = [];
  const role = el.getAttribute('role');
  if (role) bits.push(role);
  for (const a of ['data-state', 'data-highlighted', 'aria-expanded', 'aria-selected', 'data-active']) {
    const v = el.getAttribute(a);
    if (v != null) bits.push(`${a.replace(/^(data|aria)-/, '')}=${v || 'true'}`);
  }
  return bits.join(' ');
}

type DisplayNameFn = (el: Element) => string | null;
async function getDisplayNameFn(): Promise<DisplayNameFn | null> {
  try {
    const rg = await import('react-grab');
    const api = rg.getGlobalApi() as { getDisplayName?: DisplayNameFn } | null;
    return api?.getDisplayName ?? null;
  } catch {
    return null;
  }
}

function labelFor(el: Element, displayName: DisplayNameFn | null): string {
  let name: string | null = null;
  try {
    name = displayName?.(el) ?? null;
  } catch {
    /* fiber walk can throw mid-render */
  }
  const hints = roleHints(el);
  const base = name || el.tagName.toLowerCase();
  return hints ? `${base} [${hints}]` : base;
}

function stylesFor(el: Element, tokens: Map<string, string>): { styles: Record<string, string>; tok: Record<string, string> } {
  const cs = getComputedStyle(el);
  const styles: Record<string, string> = {};
  const tok: Record<string, string> = {};
  for (const p of STYLE_PROPS) {
    const v = cs.getPropertyValue(p).trim();
    if (!v || NOISE[p]?.has(v)) continue;
    if (COLOR_PROPS.has(p)) {
      const norm = normalizeColor(v);
      if (norm === 'rgba(0, 0, 0, 0)') continue; // transparent = unset
      const t = norm ? tokens.get(norm) : undefined;
      if (t) tok[p] = t;
      styles[p] = v;
    } else {
      styles[p] = v;
    }
  }
  return { styles, tok };
}

const MAX_NODES = 40;

/** Walk the subtree, collapse identical-looking siblings, return the genome. */
export async function extractGenome(root: Element): Promise<Genome> {
  const tokens = buildTokenMap();
  const displayName = await getDisplayNameFn();
  const nodes: GenomeNode[] = [];
  const bySignature = new Map<string, GenomeNode>();

  const visit = (el: Element) => {
    if (nodes.length >= MAX_NODES) return;
    if (!isVisible(el)) return;
    const classes = typeof el.className === 'string' ? el.className : '';
    const signature = `${el.tagName}|${classes}`;
    const existing = bySignature.get(signature);
    if (existing) {
      existing.count += 1;
    } else {
      const { styles, tok } = stylesFor(el, tokens);
      const node: GenomeNode = {
        label: labelFor(el, displayName),
        count: 1,
        classes,
        styles,
        tokens: tok,
      };
      bySignature.set(signature, node);
      nodes.push(node);
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(root);

  return {
    title: nodes[0]?.label ?? root.tagName.toLowerCase(),
    pageUrl: location.href,
    extractedAt: Date.now(),
    nodes,
    states: [],
  };
}

// ---------------------------------------------------------------------------
// Interaction-state capture — the "how do you catch hover/open styles" answer:
// snapshot base computed styles, then DIFF at the exact moments interaction
// signals fire — pointer/focus events, attribute flips (data-state="open",
// aria-expanded — Radix/HeadlessUI write these when menus open), and NEW
// elements appearing on document.body (portaled dropdown panels).
// ---------------------------------------------------------------------------


// Live capture status — the launcher pill renders this while the panel is
// hidden (stop control, countdown, running tally by trigger kind).
export interface GenomeCaptureSnapshot {
  active: boolean;
  msLeft: number;
  total: number;
  byTrigger: Record<string, number>;
}
let capSnapshot: GenomeCaptureSnapshot = { active: false, msLeft: 0, total: 0, byTrigger: {} };
const capSubs = new Set<(s: GenomeCaptureSnapshot) => void>();
function emitCapture(patch: Partial<GenomeCaptureSnapshot>): void {
  capSnapshot = { ...capSnapshot, ...patch };
  for (const cb of capSubs) cb(capSnapshot);
}
export function subscribeGenomeCapture(cb: (s: GenomeCaptureSnapshot) => void): () => void {
  capSubs.add(cb);
  cb(capSnapshot);
  return () => void capSubs.delete(cb);
}
let stopCaptureEarly: (() => void) | null = null;
/** Ends the running capture window immediately (pill Stop button). */
export function stopGenomeCapture(): void {
  stopCaptureEarly?.();
}
/** hover | focus | open (attr flips + portaled panels collapse to "open"). */
function triggerKind(trigger: string): string {
  if (trigger === 'hover' || trigger === 'focus') return trigger;
  return 'open';
}

export async function captureInteractionStates(
  root: Element,
  durationMs: number,
  onProgress?: (msLeft: number) => void,
): Promise<GenomeState[]> {
  const tokens = buildTokenMap();
  const displayName = await getDisplayNameFn();
  const states: GenomeState[] = [];
  const seenKeys = new Set<string>();

  // Base snapshot of every subtree element (capped like extraction).
  const base = new Map<Element, Record<string, string>>();
  const snap = (el: Element) => stylesFor(el, tokens).styles;
  const walk = (el: Element) => {
    if (base.size >= 120) return;
    base.set(el, snap(el));
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(root);

  const record = (el: Element, trigger: string) => {
    const before = base.get(el);
    if (!before) return;
    const after = snap(el);
    const changed: GenomeState['changed'] = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[key] ?? '(unset)';
      const to = after[key] ?? '(unset)';
      if (from !== to) changed[key] = { from, to };
    }
    if (Object.keys(changed).length === 0) return;
    const label = labelFor(el, displayName);
    const dedupe = `${trigger}|${label}|${Object.keys(changed).join(',')}`;
    if (seenKeys.has(dedupe)) return;
    seenKeys.add(dedupe);
    states.push({ trigger, label, changed });
    const kind = triggerKind(trigger);
    emitCapture({
      total: capSnapshot.total + 1,
      byTrigger: { ...capSnapshot.byTrigger, [kind]: (capSnapshot.byTrigger[kind] ?? 0) + 1 },
    });
  };

  // Interaction signals INSIDE the subtree.
  const onOver = (e: Event) => {
    const el = e.target as Element;
    if (el instanceof Element && base.has(el)) {
      // Styles settle after the event dispatches — read on the next frame.
      setTimeout(() => record(el, 'hover'), 50);
    }
  };
  const onFocus = (e: Event) => {
    const el = e.target as Element;
    if (el instanceof Element && base.has(el)) {
      setTimeout(() => record(el, 'focus'), 50);
    }
  };
  root.addEventListener('pointerover', onOver, true);
  root.addEventListener('focusin', onFocus, true);

  const attrObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== 'attributes' || !(m.target instanceof Element)) continue;
      const el = m.target;
      const attr = m.attributeName ?? '';
      const value = el.getAttribute(attr) ?? '';
      setTimeout(() => record(el, `attr:${attr}=${value || 'true'}`), 50);
    }
  });
  attrObserver.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-state', 'data-highlighted', 'aria-expanded', 'aria-selected', 'open'],
  });

  // Portaled content (dropdown panels render into document.body, OUTSIDE the
  // subtree): capture anything that APPEARS during the window as its own
  // mini-genome — that's the open-state panel.
  const bodyObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const added of Array.from(m.addedNodes)) {
        if (!(added instanceof Element) || root.contains(added)) continue;
        if (added.id === 'linear-grab-root' || added.closest?.('#linear-grab-root')) continue;
        setTimeout(() => {
          if (!added.isConnected || !isVisible(added)) return;
          const { styles } = stylesFor(added, tokens);
          if (Object.keys(styles).length === 0) return;
          const label = labelFor(added, displayName);
          const dedupe = `appeared|${label}`;
          if (seenKeys.has(dedupe)) return;
          seenKeys.add(dedupe);
          const changed: GenomeState['changed'] = {};
          for (const [k, v] of Object.entries(styles)) changed[k] = { from: '(absent)', to: v };
          states.push({ trigger: 'appeared (portal/open)', label, changed });
          emitCapture({
            total: capSnapshot.total + 1,
            byTrigger: { ...capSnapshot.byTrigger, open: (capSnapshot.byTrigger.open ?? 0) + 1 },
          });
        }, 50);
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: false });

  emitCapture({ active: true, msLeft: durationMs, total: 0, byTrigger: {} });
  const tick = setInterval(() => {
    const left = durationMs - (Date.now() - started);
    onProgress?.(Math.max(0, left));
    emitCapture({ msLeft: Math.max(0, left) });
  }, 250);
  const started = Date.now();
  await new Promise<void>((res) => {
    const t = setTimeout(res, durationMs);
    stopCaptureEarly = () => {
      clearTimeout(t);
      res();
    };
  });
  stopCaptureEarly = null;
  emitCapture({ active: false, msLeft: 0 });

  clearInterval(tick);
  root.removeEventListener('pointerover', onOver, true);
  root.removeEventListener('focusin', onFocus, true);
  attrObserver.disconnect();
  bodyObserver.disconnect();
  return states;
}

// ---------------------------------------------------------------------------
// Spec formatting — what "Copy spec" puts on the clipboard for agents/humans.
// ---------------------------------------------------------------------------

export function genomeToSpec(g: Genome): string {
  const lines: string[] = [
    `# Design genome: ${g.title}`,
    `Extracted from ${g.pageUrl}`,
    '',
    '## Structure',
  ];
  for (const n of g.nodes) {
    lines.push(`### ${n.label}${n.count > 1 ? ` ×${n.count}` : ''}`);
    if (n.classes) lines.push(`classes: \`${n.classes}\``);
    const styleBits = Object.entries(n.styles).map(([k, v]) => {
      const tok = n.tokens[k];
      return `${k}: ${v}${tok ? `  ← var(${tok})` : ''}`;
    });
    if (styleBits.length) lines.push('```', ...styleBits, '```');
  }
  if (g.states.length) {
    lines.push('', '## Interaction states');
    for (const s of g.states) {
      lines.push(`### ${s.label} — ${s.trigger}`);
      lines.push(
        '```',
        ...Object.entries(s.changed).map(([k, c]) => `${k}: ${c.from} → ${c.to}`),
        '```',
      );
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Standalone extract picker — hover outline + click to choose. Deliberately
// independent from react-grab's picker: extraction needs the raw Element.
// ---------------------------------------------------------------------------

export function pickElementForExtraction(): Promise<Element | null> {
  return new Promise((resolve) => {
    const outline = document.createElement('div');
    outline.setAttribute('data-linear-grab', 'true'); // slop scan skips tooling DOM by this marker
    outline.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:1.5px solid #5e6ad2;' +
      'border-radius:4px;background:rgba(94,106,210,0.08);display:none;';
    document.body.appendChild(outline);
    let current: Element | null = null;

    const hoverTarget = (e: MouseEvent): Element | null => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('#linear-grab-root')) return null;
      return el;
    };
    const onMove = (e: MouseEvent) => {
      const el = hoverTarget(e);
      current = el;
      if (!el) {
        outline.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      outline.style.display = 'block';
      outline.style.left = `${r.left - 2}px`;
      outline.style.top = `${r.top - 2}px`;
      outline.style.width = `${r.width + 4}px`;
      outline.style.height = `${r.height + 4}px`;
    };
    const done = (el: Element | null) => {
      outline.remove();
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      resolve(el);
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      done(current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
  });
}
