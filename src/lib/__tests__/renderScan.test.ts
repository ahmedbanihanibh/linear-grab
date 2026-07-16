/**
 * renderScan analyzer + snapshot tests (vitest + happy-dom).
 *
 * The analyzer is pure over plain CommitRecord objects — no bippy, no React. We
 * hand-build fixtures that drive each of the 8 heuristics (positive + negative),
 * the identical-finding merge, and report/prompt formatting.
 *
 * For the visibility rules (R3 invisible-render, R8 snapshot) happy-dom has NO
 * layout engine — getBoundingClientRect() returns zeros — so we stub the doc
 * root's width to satisfy the hasLayout guard, and stub element rects the way
 * slopScan.test.ts does.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeCommits,
  formatRenderReport,
  renderScanPrompt,
  runRenderSnapshotScan,
  type RenderFinding,
} from '../renderScan';
import type { CommitRecord, FiberEntry } from '../fiberCommits';
import { FALLBACK_RULEBOOK, type RenderRulebook } from '../renderRulebook';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function entry(p: Partial<FiberEntry> & { name: string }): FiberEntry {
  return {
    name: p.name,
    selfTime: p.selfTime ?? 0,
    phase: p.phase ?? 'update',
    changes: p.changes ?? [],
    el: p.el ?? null,
  };
}

function commit(p: Partial<CommitRecord> = {}): CommitRecord {
  const entries = p.entries ?? [];
  return {
    at: p.at ?? 0,
    duration: p.duration ?? entries.reduce((n, e) => n + e.selfTime, 0),
    entries,
    droppedEntries: p.droppedEntries ?? 0,
    mounts: p.mounts ?? {},
    nearInput: p.nearInput ?? false,
  };
}

const RB: RenderRulebook = FALLBACK_RULEBOOK; // budgets 2/8, no rule severities

function find(findings: RenderFinding[], ruleId: string | null): RenderFinding[] {
  return findings.filter((f) => f.ruleId === ruleId);
}

// Give the document a layout so the R3/R8 guards run (happy-dom is 0×0).
function withLayout(fn: () => void): void {
  const spy = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(document.documentElement, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) }),
    configurable: true,
  });
  try {
    fn();
  } finally {
    if (spy) Object.defineProperty(document.documentElement, 'getBoundingClientRect', spy);
  }
}

function stubRect(el: Element, rect: Partial<DOMRect>): void {
  const base: DOMRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ ...base, ...rect } as DOMRect);
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 1. wasted-render → R9
// ---------------------------------------------------------------------------

describe('R9 wasted-render', () => {
  it('flags ≥5 updates with all-empty changes', () => {
    const commits = Array.from({ length: 6 }, () => commit({ entries: [entry({ name: 'List', phase: 'update', changes: [], selfTime: 1 })] }));
    const found = find(analyzeCommits(commits, RB), 'R9');
    expect(found).toHaveLength(1);
    expect(found[0].description).toContain('suspected R9');
    expect(found[0].description).toContain('6×');
    expect(found[0].renders).toBe(6);
  });

  it('does not flag when a render carries a prop change', () => {
    const commits = Array.from({ length: 6 }, (_, i) =>
      commit({ entries: [entry({ name: 'List', phase: 'update', changes: i === 0 ? ['prop:value'] : [] })] }),
    );
    expect(find(analyzeCommits(commits, RB), 'R9')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. identity-churn → R5
// ---------------------------------------------------------------------------

describe('R5 identity-churn', () => {
  it('flags ≥5 updates where every change is (fn)/(ref) suffixed', () => {
    const commits = Array.from({ length: 5 }, () =>
      commit({ entries: [entry({ name: 'Row', phase: 'update', changes: ['prop:onClick(fn)', 'prop:style(ref)'], selfTime: 2 })] }),
    );
    const found = find(analyzeCommits(commits, RB), 'R5');
    expect(found).toHaveLength(1);
    expect(found[0].description).toContain('suspected R5');
    expect(found[0].changes).toEqual(expect.arrayContaining(['prop:onClick(fn)', 'prop:style(ref)']));
  });

  it('does not flag when a real value change is present (no suffix)', () => {
    const commits = Array.from({ length: 5 }, () =>
      commit({ entries: [entry({ name: 'Row', phase: 'update', changes: ['prop:value'] })] }),
    );
    expect(find(analyzeCommits(commits, RB), 'R5')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. overlay-mount-burst → R4
// ---------------------------------------------------------------------------

describe('R4 overlay-mount-burst', () => {
  it('flags ≥15 mounts of a generic component in one commit', () => {
    const commits = [commit({ mounts: { Cell: 15 } })];
    const found = find(analyzeCommits(commits, RB), 'R4');
    expect(found).toHaveLength(1);
    expect(found[0].evidence).toContain('Cell ×15');
  });

  it('flags ≥10 mounts for an overlay-ish name', () => {
    const commits = [commit({ mounts: { RowTooltip: 10 } })];
    expect(find(analyzeCommits(commits, RB), 'R4')).toHaveLength(1);
  });

  it('does not flag 14 generic mounts (below threshold)', () => {
    const commits = [commit({ mounts: { Cell: 14 } })];
    expect(find(analyzeCommits(commits, RB), 'R4')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. slow-commit → ruleId null
// ---------------------------------------------------------------------------

describe('slow-commit (budget)', () => {
  it('flags a commit over the 8ms budget with a top-3 line', () => {
    const commits = [commit({ duration: 20, entries: [entry({ name: 'Heavy', selfTime: 12 }), entry({ name: 'Mid', selfTime: 8 })] })];
    const found = find(analyzeCommits(commits, RB), null).filter((f) => f.description.startsWith('commit exceeded'));
    expect(found).toHaveLength(1);
    expect(found[0].description).toContain('20ms');
    expect(found[0].description).toContain('Heavy 12ms');
    expect(found[0].evidence).toContain('FPS'); // duration > 16
  });

  it('does not flag a commit under budget', () => {
    const commits = [commit({ duration: 5, entries: [entry({ name: 'X', selfTime: 5 })] })];
    const found = find(analyzeCommits(commits, RB), null).filter((f) => f.description.startsWith('commit exceeded'));
    expect(found).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. hot-component → ruleId null, warn
// ---------------------------------------------------------------------------

describe('hot-component (budget warn)', () => {
  it('flags a component over selfMs in ≥3 commits', () => {
    const commits = Array.from({ length: 3 }, () => commit({ entries: [entry({ name: 'Chart', selfTime: 5 })] }));
    const found = find(analyzeCommits(commits, RB), null).filter((f) => f.component === 'Chart');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warn');
    expect(found[0].evidence).toContain('worst 5ms');
  });

  it('does not flag a component hot in only 2 commits', () => {
    const commits = Array.from({ length: 2 }, () => commit({ entries: [entry({ name: 'Chart', selfTime: 5 })] }));
    const found = find(analyzeCommits(commits, RB), null).filter((f) => f.component === 'Chart');
    expect(found).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. scroll-setstate → R10
// ---------------------------------------------------------------------------

describe('R10 scroll-setstate', () => {
  it('flags ≥5 nearInput commits in a 1s window', () => {
    const commits = Array.from({ length: 5 }, (_, i) => commit({ at: i * 100, nearInput: true }));
    const found = find(analyzeCommits(commits, RB), 'R10');
    expect(found).toHaveLength(1);
    expect(found[0].description).toContain('suspected R10');
  });

  it('does not flag when nearInput commits are spread beyond 1s', () => {
    const commits = Array.from({ length: 5 }, (_, i) => commit({ at: i * 500, nearInput: true }));
    expect(find(analyzeCommits(commits, RB), 'R10')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. commit-burst → R24
// ---------------------------------------------------------------------------

describe('R24 commit-burst', () => {
  it('flags ≥8 non-input commits in a 300ms window', () => {
    const commits = Array.from({ length: 8 }, (_, i) => commit({ at: i * 20, nearInput: false }));
    const found = find(analyzeCommits(commits, RB), 'R24');
    expect(found).toHaveLength(1);
    expect(found[0].description).toContain('suspected R24');
    expect(found[0].severity).toBe('warn');
  });

  it('does not flag when input-adjacent (those are R10, not R24)', () => {
    const commits = Array.from({ length: 8 }, (_, i) => commit({ at: i * 20, nearInput: true }));
    expect(find(analyzeCommits(commits, RB), 'R24')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. invisible-render → R3
// ---------------------------------------------------------------------------

describe('R3 invisible-render', () => {
  it('flags ≥3 updates while the host DOM is hidden (0×0)', () => {
    withLayout(() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      stubRect(host, { width: 0, height: 0 }); // hidden
      const commits = Array.from({ length: 3 }, () =>
        commit({ entries: [entry({ name: 'Hidden', phase: 'update', changes: ['prop:value'], el: new WeakRef(host) })] }),
      );
      const found = find(analyzeCommits(commits, RB), 'R3');
      expect(found).toHaveLength(1);
      expect(found[0].description).toContain('suspected R3');
      expect(found[0].description).toContain('R3/R7/R23');
    });
  });

  it('does not flag when the host is visible', () => {
    withLayout(() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      stubRect(host, { width: 100, height: 40 }); // visible
      const commits = Array.from({ length: 3 }, () =>
        commit({ entries: [entry({ name: 'Shown', phase: 'update', changes: ['prop:value'], el: new WeakRef(host) })] }),
      );
      expect(find(analyzeCommits(commits, RB), 'R3')).toHaveLength(0);
    });
  });

  it('is skipped entirely when the document has no layout', () => {
    // No withLayout wrapper → documentHasLayout() is false → rule short-circuits.
    const host = document.createElement('div');
    document.body.appendChild(host);
    stubRect(host, { width: 0, height: 0 });
    const commits = Array.from({ length: 3 }, () =>
      commit({ entries: [entry({ name: 'Hidden', phase: 'update', changes: ['prop:value'], el: new WeakRef(host) })] }),
    );
    expect(find(analyzeCommits(commits, RB), 'R3')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// merge — identical findings collapse to one with count
// ---------------------------------------------------------------------------

describe('identical-finding merge', () => {
  it('merges identical slow-commit findings into one ×count', () => {
    const one = () => commit({ duration: 20, entries: [entry({ name: 'Heavy', selfTime: 20 })] });
    const commits = [one(), one(), one()];
    const found = find(analyzeCommits(commits, RB), null).filter((f) => f.description.startsWith('commit exceeded'));
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// snapshot R8
// ---------------------------------------------------------------------------

describe('R8 snapshot widgets-as-pictures', () => {
  it('flags a disabled slider as a static picture', () => {
    withLayout(() => {
      const host = document.createElement('div');
      host.innerHTML = `<div role="slider" class="rating" aria-disabled="true"></div>`;
      document.body.appendChild(host);
      const el = host.firstElementChild!;
      stubRect(el, { width: 120, height: 20 });
      const found = find(runRenderSnapshotScan(document), 'R8');
      expect(found).toHaveLength(1);
      expect(found[0].description).toContain('suspected R8');
      expect(found[0].shape).toBe('D');
    });
  });

  it('does not flag an interactive (enabled) slider', () => {
    withLayout(() => {
      const host = document.createElement('div');
      host.innerHTML = `<div role="slider" class="rating"></div>`;
      document.body.appendChild(host);
      stubRect(host.firstElementChild!, { width: 120, height: 20 });
      expect(find(runRenderSnapshotScan(document), 'R8')).toHaveLength(0);
    });
  });

  it('skips widgets inside the linear-grab own root', () => {
    withLayout(() => {
      const host = document.createElement('div');
      host.id = 'linear-grab-root';
      host.innerHTML = `<div role="switch" aria-disabled="true"></div>`;
      document.body.appendChild(host);
      stubRect(host.firstElementChild!, { width: 40, height: 20 });
      expect(find(runRenderSnapshotScan(document), 'R8')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// report + prompt formatting
// ---------------------------------------------------------------------------

describe('formatRenderReport + renderScanPrompt', () => {
  it('report groups by ruleId, errors first, and says SUSPECTED', () => {
    const commits = [
      ...Array.from({ length: 6 }, () => commit({ entries: [entry({ name: 'List', phase: 'update', changes: [], selfTime: 1 })] })),
      commit({ mounts: { RowTooltip: 12 } }),
    ];
    const findings = analyzeCommits(commits, RB);
    const report = formatRenderReport(findings);
    expect(report).toContain('# Render scan');
    expect(report).toContain('SUSPECTED');
    expect(report).toContain('## R9');
    expect(report).toContain('## R4');
  });

  it('prompt embeds the fixText for present rules and a doc pointer when missing', () => {
    const book: RenderRulebook = {
      budgets: { selfMs: 2, commitMs: 8 },
      rules: {
        R9: { id: 'R9', slug: 'no-wasted-render', severity: 'error', ruleText: '', detectText: '', fixText: 'Memoize the subtree or split the store selector.' },
      },
    };
    const commits = [
      ...Array.from({ length: 6 }, () => commit({ entries: [entry({ name: 'List', phase: 'update', changes: [], selfTime: 1 })] })),
      commit({ mounts: { Cell: 20 } }), // R4 — not in this book → doc pointer
    ];
    const findings = analyzeCommits(commits, book);
    const prompt = renderScanPrompt(findings, book);
    expect(prompt).toContain('Memoize the subtree');
    expect(prompt).toContain('see React-rerender-primitives.md R4');
    expect(prompt).toContain('SUSPECTED');
  });
});

describe('framework-noise filter', () => {
  it('ignores Next.js internals but keeps app components, and honors opts.ignore', () => {
    const mk = (name: string) =>
      Array.from({ length: 6 }, () =>
        commit({ entries: [entry({ name, phase: 'update', changes: [] })] }),
      );
    // HotReload (built-in noise) and MyWidget (app) both re-render 6× wasted.
    const commits = [...mk('HotReload'), ...mk('MyWidget'), ...mk('LegacyThing')];
    const withDefault = analyzeCommits(commits, FALLBACK_RULEBOOK);
    expect(withDefault.some((f) => f.component === 'HotReload')).toBe(false);
    expect(withDefault.some((f) => f.component === 'MyWidget')).toBe(true);
    expect(withDefault.some((f) => f.component === 'LegacyThing')).toBe(true);
    // opts.ignore silences an app component by exact name or regex.
    const withIgnore = analyzeCommits(commits, FALLBACK_RULEBOOK, { ignore: ['^Legacy'] });
    expect(withIgnore.some((f) => f.component === 'LegacyThing')).toBe(false);
    expect(withIgnore.some((f) => f.component === 'MyWidget')).toBe(true);
  });
});
