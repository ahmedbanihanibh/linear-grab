/**
 * Slop-scan engine tests (vitest + happy-dom).
 *
 * happy-dom has NO layout engine: getBoundingClientRect() returns zeros and
 * scrollHeight/clientHeight are 0. Layout-dependent rules are still testable —
 * `stubMetrics` defines the metrics the rule reads (plain property/method
 * access), and rules deliberately read them without destructuring so the stubs
 * apply. happy-dom DOES reflect simple inline styles into getComputedStyle, so
 * style fixtures set styles inline (el.style / style="…").
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __setExtraRulesForTest,
  formatSlopReport,
  runSlopScan,
  type SlopFinding,
} from '../slopScan';
import { easingViolation, isIntentionalMotion } from '../cssShared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Metrics {
  scrollHeight?: number;
  clientHeight?: number;
  scrollWidth?: number;
  clientWidth?: number;
  rect?: Partial<DOMRect>;
}

/** Stub the layout metrics happy-dom can't compute. */
function stubMetrics(el: Element, m: Metrics): void {
  for (const key of ['scrollHeight', 'clientHeight', 'scrollWidth', 'clientWidth'] as const) {
    if (m[key] != null) {
      Object.defineProperty(el, key, { value: m[key], configurable: true });
    }
  }
  if (m.rect) {
    const base: DOMRect = {
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
      toJSON: () => ({}),
    };
    const rect = { ...base, ...m.rect } as DOMRect;
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => rect;
  }
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function findRule(findings: SlopFinding[], ruleId: string): SlopFinding[] {
  return findings.filter((f) => f.ruleId === ruleId);
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  __setExtraRulesForTest([]);
});

// ---------------------------------------------------------------------------
// 1. radius-vocabulary
// ---------------------------------------------------------------------------

describe('radius-vocabulary', () => {
  it('flags an off-vocabulary 6px radius', () => {
    const host = mount(`<div style="border-radius:6px;width:100px;height:40px"></div>`);
    const el = host.firstElementChild!;
    stubMetrics(el, { rect: { width: 100, height: 40 } });
    const found = findRule(runSlopScan(document), 'radius-vocabulary');
    expect(found).toHaveLength(1);
    expect(found[0].evidence).toContain('6px');
  });

  it('passes 8px, a pill, and 0', () => {
    const host = mount(`
      <div id="a" style="border-radius:8px;width:100px;height:40px"></div>
      <div id="b" style="border-radius:9999px;width:100px;height:40px"></div>
      <div id="c" style="border-radius:0;width:100px;height:40px"></div>`);
    for (const id of ['a', 'b', 'c']) stubMetrics(host.querySelector('#' + id)!, { rect: { width: 100, height: 40 } });
    expect(findRule(runSlopScan(document), 'radius-vocabulary')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. row-radius-token
// ---------------------------------------------------------------------------

describe('row-radius-token', () => {
  it('flags a 6px row among 28px siblings in a scroller', () => {
    const host = mount(`
      <div id="scroller" style="overflow-y:auto">
        <div id="r1" style="border-radius:6px"></div>
        <div id="r2" style="border-radius:8px"></div>
        <div id="r3" style="border-radius:8px"></div>
      </div>`);
    stubMetrics(host.querySelector('#scroller')!, { rect: { width: 200, height: 84 } });
    for (const id of ['r1', 'r2', 'r3']) stubMetrics(host.querySelector('#' + id)!, { rect: { width: 200, height: 28 } });
    const found = findRule(runSlopScan(document), 'row-radius-token');
    expect(found).toHaveLength(1);
    expect(found[0].selector).toContain('div');
  });
});

// ---------------------------------------------------------------------------
// 3. active-fill-token
// ---------------------------------------------------------------------------

describe('active-fill-token', () => {
  it('flags an aria-selected row with #F0F0F1 bg', () => {
    const host = mount(`<div role="tablist"><div id="row" aria-selected="true" style="background-color:rgb(240,240,241)"></div></div>`);
    stubMetrics(host.querySelector('#row')!, { rect: { width: 100, height: 30 } });
    const found = findRule(runSlopScan(document), 'active-fill-token');
    expect(found).toHaveLength(1);
  });

  it('passes a translucent fog fill', () => {
    const host = mount(`<div role="tablist"><div id="row" aria-selected="true" style="background-color:rgba(0,0,0,0.06)"></div></div>`);
    stubMetrics(host.querySelector('#row')!, { rect: { width: 100, height: 30 } });
    expect(findRule(runSlopScan(document), 'active-fill-token')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. inline-style-state
// ---------------------------------------------------------------------------

describe('inline-style-state', () => {
  it('flags a .pb-row-action with an inline background', () => {
    const host = mount(`<button class="pb-row-action" style="background:none"></button>`);
    stubMetrics(host.firstElementChild!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'inline-style-state')).toHaveLength(1);
  });

  it('passes a .pb-row-action with layout-only inline style', () => {
    const host = mount(`<button class="pb-row-action" style="margin-left:4px"></button>`);
    stubMetrics(host.firstElementChild!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'inline-style-state')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. icon-button-no-hover
// ---------------------------------------------------------------------------

describe('icon-button-no-hover', () => {
  it('flags an icon button with no :hover rule', () => {
    const host = mount(`<button id="b"><svg></svg></button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'icon-button-no-hover')).toHaveLength(1);
  });

  it('passes an icon button carrying .pb-row-action', () => {
    const host = mount(`<button id="b" class="pb-row-action"><svg></svg></button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'icon-button-no-hover')).toHaveLength(0);
  });

  it('passes when a nested @media(hover) :hover rule matches', () => {
    const style = document.createElement('style');
    style.textContent = `@media (hover: hover) { .icon-btn:hover { background: red } }`;
    document.head.appendChild(style);
    const host = mount(`<button id="b" class="icon-btn"><svg></svg></button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'icon-button-no-hover')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. icon-button-no-tooltip
// ---------------------------------------------------------------------------

describe('icon-button-no-tooltip', () => {
  it('flags a bare icon button', () => {
    const host = mount(`<button id="b"><svg></svg></button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'icon-button-no-tooltip')).toHaveLength(1);
  });

  it('passes an icon button with aria-describedby', () => {
    const host = mount(`<button id="b" aria-describedby="tip"><svg></svg></button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 24, height: 24 } });
    expect(findRule(runSlopScan(document), 'icon-button-no-tooltip')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. unvirtualized-scroller
// ---------------------------------------------------------------------------

describe('unvirtualized-scroller', () => {
  it('flags a 200-child overflowing scroller', () => {
    const host = mount(`<div id="s" style="overflow-y:auto">${'<div></div>'.repeat(200)}</div>`);
    const s = host.querySelector('#s')!;
    stubMetrics(s, { scrollHeight: 4000, clientHeight: 400, rect: { width: 300, height: 400 } });
    expect(findRule(runSlopScan(document), 'unvirtualized-scroller')).toHaveLength(1);
  });

  it('passes a 20-child scroller', () => {
    const host = mount(`<div id="s" style="overflow-y:auto">${'<div></div>'.repeat(20)}</div>`);
    const s = host.querySelector('#s')!;
    stubMetrics(s, { scrollHeight: 800, clientHeight: 400, rect: { width: 300, height: 400 } });
    expect(findRule(runSlopScan(document), 'unvirtualized-scroller')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. scroll-no-fade + phantom-fade
// ---------------------------------------------------------------------------

describe('scroll fades', () => {
  it('flags an overflowing horizontal strip with no fade', () => {
    const host = mount(`<div id="s" style="overflow-x:auto"><div></div></div>`);
    const s = host.querySelector('#s')!;
    stubMetrics(s, { scrollWidth: 800, clientWidth: 300, rect: { width: 300, height: 40 } });
    expect(findRule(runSlopScan(document), 'scroll-no-fade')).toHaveLength(1);
  });

  it('flags a masked but non-overflowing strip as phantom', () => {
    const host = mount(`<div id="s" style="overflow-x:auto;-webkit-mask-image:linear-gradient(90deg,#000,transparent)"><div></div></div>`);
    const s = host.querySelector('#s')!;
    stubMetrics(s, { scrollWidth: 300, clientWidth: 300, rect: { width: 300, height: 40 } });
    const found = runSlopScan(document);
    expect(findRule(found, 'phantom-fade')).toHaveLength(1);
    expect(findRule(found, 'scroll-no-fade')).toHaveLength(0);
  });

  it('passes a masked + overflowing strip', () => {
    const host = mount(`<div id="s" style="overflow-x:auto;-webkit-mask-image:linear-gradient(90deg,#000,transparent)"><div></div></div>`);
    const s = host.querySelector('#s')!;
    stubMetrics(s, { scrollWidth: 800, clientWidth: 300, rect: { width: 300, height: 40 } });
    const found = runSlopScan(document);
    expect(findRule(found, 'scroll-no-fade')).toHaveLength(0);
    expect(findRule(found, 'phantom-fade')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. font-family
// ---------------------------------------------------------------------------

describe('font-family', () => {
  it('flags Inter', () => {
    const host = mount(`<p id="p" style="font-family:Inter">hi</p>`);
    stubMetrics(host.querySelector('#p')!, { rect: { width: 40, height: 16 } });
    expect(findRule(runSlopScan(document), 'font-family')).toHaveLength(1);
  });

  it('passes Geist', () => {
    const host = mount(`<p id="p" style="font-family:Geist">hi</p>`);
    stubMetrics(host.querySelector('#p')!, { rect: { width: 40, height: 16 } });
    expect(findRule(runSlopScan(document), 'font-family')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. uppercase-label
// ---------------------------------------------------------------------------

describe('uppercase-label', () => {
  it('flags 11px uppercase text', () => {
    const host = mount(`<span id="s" style="text-transform:uppercase;font-size:11px">label</span>`);
    stubMetrics(host.querySelector('#s')!, { rect: { width: 40, height: 14 } });
    expect(findRule(runSlopScan(document), 'uppercase-label')).toHaveLength(1);
  });

  it('passes 11px non-uppercase text', () => {
    const host = mount(`<span id="s" style="text-transform:none;font-size:11px">label</span>`);
    stubMetrics(host.querySelector('#s')!, { rect: { width: 40, height: 14 } });
    expect(findRule(runSlopScan(document), 'uppercase-label')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. editor-shadow
// ---------------------------------------------------------------------------

describe('editor-shadow', () => {
  it('flags a shadowed panel under [data-editor-surface]', () => {
    const host = mount(`<div data-editor-surface><div id="panel" style="box-shadow:0 4px 12px rgba(0,0,0,0.2)"></div></div>`);
    stubMetrics(host.querySelector('#panel')!, { rect: { width: 200, height: 100 } });
    expect(findRule(runSlopScan(document), 'editor-shadow')).toHaveLength(1);
  });

  it('passes a hairline ring', () => {
    const host = mount(`<div data-editor-surface><div id="panel" style="box-shadow:0px 0px 0px 0.5px rgba(0,0,0,0.1)"></div></div>`);
    stubMetrics(host.querySelector('#panel')!, { rect: { width: 200, height: 100 } });
    expect(findRule(runSlopScan(document), 'editor-shadow')).toHaveLength(0);
  });

  it('passes an all-transparent shadow stack (flattened Tailwind ring vars)', () => {
    const host = mount(
      `<div data-editor-surface><div id="panel" style="box-shadow:rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 1px 2px 0px"></div></div>`,
    );
    stubMetrics(host.querySelector('#panel')!, { rect: { width: 200, height: 100 } });
    expect(findRule(runSlopScan(document), 'editor-shadow')).toHaveLength(0);
  });

  it('still flags when one layer of the stack is visible', () => {
    const host = mount(
      `<div data-editor-surface><div id="panel" style="box-shadow:rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.2) 0px 4px 12px 0px"></div></div>`,
    );
    stubMetrics(host.querySelector('#panel')!, { rect: { width: 200, height: 100 } });
    expect(findRule(runSlopScan(document), 'editor-shadow')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Devtools DOM exclusion — tooling pixels are never the app's contract
// ---------------------------------------------------------------------------

describe('devtools exclusion', () => {
  it('never grades linear-grab-tagged or react-grab overlay DOM', () => {
    const host = mount(
      `<div data-linear-grab="true" style="border-radius:4px;width:100px;height:40px"></div>` +
        `<div data-react-grab="true"><div style="border-radius:6px;width:100px;height:40px"></div></div>` +
        `<div id="linear-grab-root"><div style="border-radius:5px;width:100px;height:40px"></div></div>`,
    );
    for (const el of Array.from(host.querySelectorAll('div'))) {
      stubMetrics(el, { rect: { width: 100, height: 40 } });
    }
    expect(findRule(runSlopScan(document), 'radius-vocabulary')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12. menu-icons-all-or-none
// ---------------------------------------------------------------------------

describe('menu-icons-all-or-none', () => {
  it('flags a menu with 2/3 icons', () => {
    const host = mount(`
      <div role="menu">
        <div role="menuitem"><svg></svg>Edit</div>
        <div role="menuitem"><svg></svg>Copy</div>
        <div role="menuitem">Settings</div>
      </div>`);
    host.querySelectorAll('*').forEach((e) => stubMetrics(e, { rect: { width: 100, height: 24 } }));
    expect(findRule(runSlopScan(document), 'menu-icons-all-or-none')).toHaveLength(1);
  });

  it('passes 3/3 and 0/3 menus', () => {
    const full = mount(`<div role="menu"><div role="menuitem"><svg></svg>A</div><div role="menuitem"><svg></svg>B</div><div role="menuitem"><svg></svg>C</div></div>`);
    const none = mount(`<div role="menu"><div role="menuitem">A</div><div role="menuitem">B</div><div role="menuitem">C</div></div>`);
    [full, none].forEach((h) => h.querySelectorAll('*').forEach((e) => stubMetrics(e, { rect: { width: 100, height: 24 } })));
    expect(findRule(runSlopScan(document), 'menu-icons-all-or-none')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13. cursor-mismatch
// ---------------------------------------------------------------------------

describe('cursor-mismatch', () => {
  it('flags a button with cursor:text', () => {
    const host = mount(`<button id="b" style="cursor:text">Save</button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'cursor-mismatch')).toHaveLength(1);
  });

  it('passes static text with pointer inside a clickable ancestor', () => {
    const host = mount(`<button><span id="s" style="cursor:pointer">Label</span></button>`);
    stubMetrics(host.querySelector('#s')!, { rect: { width: 40, height: 16 } });
    expect(findRule(runSlopScan(document), 'cursor-mismatch')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 14. runSlopScan isolation — a throwing rule never blocks others
// ---------------------------------------------------------------------------

describe('scan isolation', () => {
  it('a throwing rule is skipped; other rules still report', () => {
    __setExtraRulesForTest([
      {
        id: 'boom',
        part: 'test',
        severity: 'error',
        description: 'throws',
        check() {
          throw new Error('boom');
        },
      },
    ]);
    const host = mount(`<p id="p" style="font-family:Inter">hi</p>`);
    stubMetrics(host.querySelector('#p')!, { rect: { width: 40, height: 16 } });
    const found = runSlopScan(document);
    expect(findRule(found, 'boom')).toHaveLength(0);
    expect(findRule(found, 'font-family').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 15. report format
// ---------------------------------------------------------------------------

describe('formatSlopReport', () => {
  it('groups by ruleId, errors first, count desc', () => {
    const findings: SlopFinding[] = [
      { ruleId: 'w', part: 'Part 5', severity: 'warn', description: 'warn rule', selector: 'span', evidence: 'x' },
      { ruleId: 'e', part: '§40', severity: 'error', description: 'err rule', selector: 'div.a', evidence: 'y' },
      { ruleId: 'e', part: '§40', severity: 'error', description: 'err rule', selector: 'div.b', evidence: 'z' },
    ];
    const report = formatSlopReport(findings);
    expect(report).toContain('# Slop scan — 2 errors, 1 warn (3 total)');
    // error group before warn group
    expect(report.indexOf('## e — error ×2')).toBeLessThan(report.indexOf('## w — warn ×1'));
    expect(report).toContain('- `div.a` — y');
  });
});

// ---------------------------------------------------------------------------
// 16. transition-all
// ---------------------------------------------------------------------------

describe('transition-all', () => {
  it('flags a button with transition:all', () => {
    // happy-dom does NOT expand the `transition:` shorthand into longhand
    // computed props — set the longhand the rule reads (see spec quirk note).
    const host = mount(`<button id="b" style="transition-property:all;transition-duration:100ms">x</button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-all')).toHaveLength(1);
  });

  it('passes scoped transition-property', () => {
    const host = mount(`<button id="b" style="transition-property:background-color;transition-duration:100ms">x</button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-all')).toHaveLength(0);
  });

  it('exempts transition:all inside popover content', () => {
    const host = mount(`<div data-slot="popover-content"><button id="b" style="transition-property:all;transition-duration:100ms">x</button></div>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-all')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 17. transition-paint-prop
// ---------------------------------------------------------------------------

describe('transition-paint-prop', () => {
  it('flags an input transitioning box-shadow', () => {
    const host = mount(`<input id="i" style="transition-property:box-shadow;transition-duration:100ms" />`);
    stubMetrics(host.querySelector('#i')!, { rect: { width: 120, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-paint-prop')).toHaveLength(1);
  });

  it('passes color + border-color only', () => {
    const host = mount(`<input id="i" style="transition-property:color, border-color;transition-duration:100ms" />`);
    stubMetrics(host.querySelector('#i')!, { rect: { width: 120, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-paint-prop')).toHaveLength(0);
  });

  it('exempts a [data-panel] child transitioning width', () => {
    const host = mount(`<div data-panel><div id="p" style="transition-property:width;transition-duration:100ms"></div></div>`);
    stubMetrics(host.querySelector('#p')!, { rect: { width: 200, height: 100 } });
    expect(findRule(runSlopScan(document), 'transition-paint-prop')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 18. transition-too-slow
// ---------------------------------------------------------------------------

describe('transition-too-slow', () => {
  it('flags 150ms', () => {
    const host = mount(`<button id="b" style="transition-property:background-color;transition-duration:150ms">x</button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-too-slow')).toHaveLength(1);
  });

  it('passes 100ms and 75ms', () => {
    const a = mount(`<button id="a" style="transition-property:background-color;transition-duration:100ms">x</button>`);
    const b = mount(`<button id="b" style="transition-property:background-color;transition-duration:75ms">x</button>`);
    stubMetrics(a.querySelector('#a')!, { rect: { width: 60, height: 28 } });
    stubMetrics(b.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'transition-too-slow')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 19. ease-in-feedback
// ---------------------------------------------------------------------------

describe('ease-in-feedback', () => {
  it('flags ease-in', () => {
    const host = mount(`<button id="b" style="transition-property:background-color;transition-duration:100ms;transition-timing-function:ease-in">x</button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'ease-in-feedback')).toHaveLength(1);
  });

  it('passes the house ease-out bezier', () => {
    const host = mount(`<button id="b" style="transition-property:background-color;transition-duration:100ms;transition-timing-function:cubic-bezier(.2,0,.1,1)">x</button>`);
    stubMetrics(host.querySelector('#b')!, { rect: { width: 60, height: 28 } });
    expect(findRule(runSlopScan(document), 'ease-in-feedback')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 20. press-instant-rule-missing
// ---------------------------------------------------------------------------

describe('press-instant-rule-missing', () => {
  it('emits exactly ONE finding when no press-instant rule exists', () => {
    mount(`<button>x</button>`);
    const found = findRule(runSlopScan(document), 'press-instant-rule-missing');
    expect(found).toHaveLength(1);
  });

  it('passes when the rule is present', () => {
    const style = document.createElement('style');
    style.textContent = `button:active { transition-duration: 0s }`;
    document.head.appendChild(style);
    mount(`<button>x</button>`);
    expect(findRule(runSlopScan(document), 'press-instant-rule-missing')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cssShared unit tests
// ---------------------------------------------------------------------------

describe('cssShared.easingViolation', () => {
  it('flags ease-in-out', () => {
    expect(easingViolation('ease-in-out')).toBe('ease-in-out');
  });

  it('flags an ease-in-shaped bezier (x1>=0.4, y1<x1/2)', () => {
    expect(easingViolation('cubic-bezier(0.6, 0.1, 0.9, 1)')).toBe('cubic-bezier(0.6, 0.1, 0.9, 1)');
  });

  it('passes the house ease-out bezier', () => {
    expect(easingViolation('cubic-bezier(.2,0,.1,1)')).toBeNull();
  });
});

describe('cssShared.isIntentionalMotion', () => {
  it('exempts an element inside popover content', () => {
    const host = mount(`<div data-slot="popover-content"><button id="b">x</button></div>`);
    expect(isIntentionalMotion(host.querySelector('#b')!, ['all'])).toBe(true);
  });

  it('does not exempt a plain button', () => {
    const host = mount(`<button id="b">x</button>`);
    expect(isIntentionalMotion(host.querySelector('#b')!, ['all'])).toBe(false);
  });

  it('exempts a [data-panel] child ONLY for size props', () => {
    const host = mount(`<div data-panel><div id="p">x</div></div>`);
    const el = host.querySelector('#p')!;
    expect(isIntentionalMotion(el, ['width'])).toBe(true);
    expect(isIntentionalMotion(el, ['background-color'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regressions from the first real-app report (v0.25.2)
// ---------------------------------------------------------------------------

describe('regressions: real-app false positives', () => {
  it('hardcoded-status-hex: trio color in computed rgb form is exempt', () => {
    // rgb(80, 227, 194) IS #50E3C2 — the first report flagged it because the
    // computed branch never compared against the trio.
    const host = mount(`<span id="s" style="color: rgb(80, 227, 194); font-size: 11px">up</span>`);
    void host;
    expect(findRule(runSlopScan(document), 'hardcoded-status-hex')).toHaveLength(0);
  });

  it('cursor-mismatch: label (and its text) with pointer is interactive by proxy', () => {
    mount(
      `<label style="cursor: pointer"><span id="t" style="cursor: pointer">Enable</span><input type="checkbox" /></label>`,
    );
    expect(findRule(runSlopScan(document), 'cursor-mismatch')).toHaveLength(0);
  });

  it('scroll-no-fade: overflowing but non-scrollable elements are not scrollers', () => {
    const host = mount(`<span id="s" style="overflow: visible">truncated text</span>`);
    const el = host.querySelector('#s')!;
    stubMetrics(el, { scrollWidth: 150, clientWidth: 40 });
    expect(findRule(runSlopScan(document), 'scroll-no-fade')).toHaveLength(0);
  });

  it('identical findings merge into one with a count', () => {
    const host = mount(
      `<div>
         <div class="inline-flex items-center" style="border-radius: 4px">a</div>
         <div class="inline-flex items-center" style="border-radius: 4px">b</div>
         <div class="inline-flex items-center" style="border-radius: 4px">c</div>
       </div>`,
    );
    for (const el of host.querySelectorAll('div[class]')) {
      stubMetrics(el, { rect: { width: 40, height: 20 } });
    }
    const found = findRule(runSlopScan(document), 'radius-vocabulary');
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(3);
  });
});
