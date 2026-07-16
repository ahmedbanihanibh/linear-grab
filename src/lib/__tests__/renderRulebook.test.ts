/**
 * renderRulebook parser tests (vitest). Pure string in → structured out; no DOM.
 *
 * The fixture mirrors the real `React-rerender-primitives.md` shape: a budget
 * preamble line, three `###` rule sections (an error rule, a warn rule, and one
 * whose heading carries a `— the hybrid focus mirror (error)` prose suffix), and
 * a deliberately malformed section that must be skipped without throwing.
 */

import { describe, expect, it } from 'vitest';
import { FALLBACK_RULEBOOK, parseRenderRulebook } from '../renderRulebook';

const DOC = `
# React re-render primitives

An interaction commit budget of **≤2ms self time**; any single commit >8ms is a
frame-drop and must be split.

## Part 4 · The rules

### R4 · \`per-row-overlays-mount-on-intent\` (error)

**Rule:** Per-row overlays (tooltips, menus) must mount on hover/focus intent,
never eagerly for every row.

**Detect:** ≥15 mounts of one overlay component in a single commit.

**Fix (canonical: intent gate):** Wrap the overlay in an \`onMouseEnter\` intent
gate and render \`null\` until the row is actually hovered.

### R11 · \`derived-state-in-render\` (warn)

**Rule:** Derived values are computed with \`useMemo\`, not stored in state and
synced with an effect.

**Fix:** Delete the state + effect; compute the value inline or with
\`useMemo\`.

### R26 · \`route-is-navigation-not-selection\` — the hybrid focus mirror (error)

**Rule:** Route changes are navigation, not selection state — do not mirror the
route into a \`selectedId\` state.

**Detect:** A \`setState\` in a route-change effect.

**Fix:** Read the route directly; drop the mirror.

### Rmalformed no backticks here (error)

**Rule:** this heading has no backticked slug and must be skipped.

---
`;

describe('parseRenderRulebook', () => {
  const book = parseRenderRulebook(DOC);

  it('parses budgets from the preamble', () => {
    expect(book.budgets).toEqual({ selfMs: 2, commitMs: 8 });
  });

  it('extracts ids, slugs, and severities', () => {
    expect(book.rules.R4.slug).toBe('per-row-overlays-mount-on-intent');
    expect(book.rules.R4.severity).toBe('error');
    expect(book.rules.R11.severity).toBe('warn');
    expect(book.rules.R26.slug).toBe('route-is-navigation-not-selection');
    expect(book.rules.R26.severity).toBe('error');
  });

  it('extracts Rule / Fix / Detect text with variant Fix labels', () => {
    expect(book.rules.R4.ruleText).toContain('Per-row overlays');
    expect(book.rules.R4.detectText).toContain('15 mounts');
    // `**Fix (canonical: intent gate):**` variant resolves.
    expect(book.rules.R4.fixText).toContain('intent');
    expect(book.rules.R4.fixText).toContain('onMouseEnter');
    // plain `**Fix:**`
    expect(book.rules.R11.fixText).toContain('Delete the state');
  });

  it('keeps code backticks, strips bold emphasis', () => {
    expect(book.rules.R11.ruleText).toContain('`useMemo`');
    expect(book.rules.R11.ruleText).not.toContain('**');
  });

  it('skips the malformed (no-slug) section without throwing', () => {
    expect(Object.keys(book.rules).sort()).toEqual(['R11', 'R26', 'R4']);
    expect(book.rules.Rmalformed).toBeUndefined();
  });

  it('falls back to default budgets when the preamble is absent', () => {
    const b = parseRenderRulebook('### R1 · `x` (warn)\n\n**Rule:** nothing.');
    expect(b.budgets).toEqual({ selfMs: 2, commitMs: 8 });
    expect(b.rules.R1.severity).toBe('warn');
  });

  it('never throws on garbage input', () => {
    expect(() => parseRenderRulebook('')).not.toThrow();
    expect(() => parseRenderRulebook('### not a rule\n**Fix')).not.toThrow();
  });

  it('FALLBACK_RULEBOOK is budgets 2/8 with no rules', () => {
    expect(FALLBACK_RULEBOOK.budgets).toEqual({ selfMs: 2, commitMs: 8 });
    expect(FALLBACK_RULEBOOK.rules).toEqual({});
  });
});
