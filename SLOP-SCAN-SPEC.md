# Slop Scan — design-system drift auditor (implementation brief)

Goal: a third auditor next to `cssSlowdown` — scans the LIVE page DOM for
violations of the Protocolbase design contract
(`~/Documents/protocolbase-code-app/Linear -primitives.md` — read it fully
first; it is the source of every rule below). Surfaces findings in
`DesignView` and exports them as a copyable report (rule id + selector +
evidence) the owner pastes back to the app session.

## Architecture (mirror `src/lib/cssSlowdown.ts`)

`src/lib/slopScan.ts`:
- `interface SlopRule { id: string; part: string; severity: "error"|"warn";
  description: string; check(root: ParentNode): SlopFinding[] }`
- `interface SlopFinding { ruleId: string; selector: string; evidence:
  string; el?: WeakRef<Element> }` (selector = short unique CSS path;
  evidence = the offending computed value / class)
- `runSlopScan(root?: ParentNode): SlopFinding[]` — pure, sync, runs all
  rules; each rule isolated in try/catch (one broken rule never kills the
  scan).
- Panel UI in DesignView: "Scan page" button + grouped findings list
  (group by ruleId, count badge, click → `el.scrollIntoView` + outline
  flash), plus "Copy report".

Rules are PURE functions over DOM + `getComputedStyle` — every rule unit-
testable in happy-dom/jsdom by building a fixture element and asserting
findings. NO app-code imports.

## Rule set v1 (each maps to a Linear-primitives section)

**Radius vocabulary (§40 / Part 1 chrome table)**
- `radius-vocabulary`: for every element with a nonzero computed
  border-radius, resolved px must be one of {8, 12, 16} or fully-rounded
  (radius ≥ half the min dimension) or 0. Evidence: computed value.
- `row-radius-token`: elements matching row heuristics (h between 26–50px,
  inside an overflow-auto ancestor, siblings ≥3 with same height) must have
  radius 0 or exactly `var(--row-radius)` resolved (8px).

**State fills (§11, §40)**
- `active-fill-token`: an element whose background equals the LIGHT
  `#F0F0F1`/dark `#232325` (bg-secondary) AND sits in a nav/list context
  (role=tab/button, aria-selected, inside [role=tablist] or a rail) →
  flag "active fill must be var(--selected)".
  PRECONDITION (computed styles erase token provenance): at scan start,
  resolve `--selected` on :root and compare against bg-secondary for the
  current theme — if they resolve to the SAME color the rule is blind;
  skip it and emit one warn finding "active-fill-token unverifiable:
  --selected resolves equal to bg-secondary" instead of silently passing.
- `inline-style-state`: any element with BOTH a class containing
  `pb-row-action` (or matching row-action heuristics) AND an inline
  style setting background/color → flag (inline styles kill class states).

**Hover/interactive affordance (§21 addendum, Part 10)**
- `icon-button-no-hover`: button/[role=button] whose only content is an
  svg: capture computed background at rest, dispatch synthetic
  `mouseenter`/`:hover` unavailable — instead check it carries a class
  with a `hover:` rule OR `.pb-row-action`; else flag. (Static heuristic:
  scan matched CSSRules via `document.styleSheets` for a :hover selector
  hitting the element.)
  IMPLEMENTATION (three known walls): (a) cross-origin sheets throw on
  `.cssRules` — try/catch per sheet, skip silently; (b) Tailwind v4 nests
  hover rules inside `@media (hover:hover)` and `@layer` blocks — RECURSE
  every CSSGroupingRule, never walk top-level rules only; (c) match via
  `el.matches(selectorText.replace(/:hover/g, ''))` per selector in the
  list. Build the hover-selector index ONCE per scan, not per element.
  Exemption: elements with framer-motion/JS-driven hover leave no CSS
  trace — skip elements carrying `[data-framer-*]` or inline
  `will-change: transform` as likely JS-hover; keep severity "warn".
- `icon-button-no-tooltip`: icon-only button without aria-describedby /
  data-slot="tooltip-trigger" / title-on-menu-row exemption → flag (§7).

**Scrolling (§0–§2)**
- `unvirtualized-scroller`: element with overflow(-y/x) auto|scroll,
  scrollHeight > 2×clientHeight, and >60 direct element children → flag
  "virtualize".
- `scroll-no-fade`: horizontal scroller (scrollWidth > clientWidth+8) with
  neither `scroll-fade-x`/`scroll-fade-x-js` class nor mask-image → flag.
- `phantom-fade`: element with a mask-image fade but scrollWidth ≤
  clientWidth (nothing hidden) → flag "fade lies".
- `scrollbar-flush`: scroller whose padding-right < 8px while overflowing
  vertically with content elements reaching within 4px of right edge.

**Typography & tokens (Part 5)**
- `font-family`: computed font-family not starting with Geist/Geist Mono/
  ui-monospace fallback chain → flag.
- `uppercase-label`: computed text-transform uppercase on elements with
  font-size < 13px → flag (§25).
- `hardcoded-status-hex`: inline style or computed color exactly matching
  a hex NOT in {#50E3C2, #EE0000, #F5A623} brand trio while being a
  saturated non-token color on small UI text — WARN only (heuristic).
- `editor-shadow`: inside an editor surface (root [data-editor-surface] or
  URL contains /editor/), elements with a computed box-shadow that is not
  a 0.5px hairline ring or an approved popover/card/input token shadow →
  flag (Part 5 "flat" rule).

**Layout shift & clipping (§13, §24, Part 10)**
- `focusring-clip`: focusable element whose nearest overflow-hidden
  ancestor is < 4px from its border box on any side → warn "focus ring
  will clip".
- `fixed-width-in-pane`: element with computed width equal to a hard px
  value (from inline style or matched rule with `w-[Npx]`, N ≥ 200) inside
  a resizable pane ([data-panel] / flex-basis sibling) → warn.

**Menus (§21)**
NOTE: menus only exist in the DOM while OPEN — a static scan will
virtually never catch one. v1: document "open the menu, then Scan" in the
panel hint. v2 TODO: hook the genome interaction-capture MutationObserver
(portal childList) to run menu rules against each captured open-state.
- `menu-icons-all-or-none`: within one [role=menu], count items with a
  leading svg — if 0 < n < total → flag.
- `menu-icon-mixed-weight`: svgs inside one [role=menu] where some have
  fill=currentColor solid paths and others stroke-based, or rendered
  sizes differ by >2px → flag (canonical trio rule).

**Selection/cursor (Part 5)**
- `chrome-selectable`: elements matching rail/pill/tab heuristics without
  user-select:none → warn.
- `cursor-mismatch`: [role=button]/button with cursor:text, or static
  text (p, h1-h6, span without handlers) with cursor:pointer → warn.

**Transitions & interaction feedback (§42)**
Interactive = button / a / [role=button|tab|menuitem|option] / input /
textarea / select. Exempt from this whole group: popover/menu/dialog
CONTENT subtrees ([data-slot*=content], [role=menu|dialog|listbox] —
entry/exit motion is intentional), svg icons (chevron micro-motion), and
elements inside [data-panel] transitioning width/height (panel motion).
- `transition-all`: interactive element whose computed transition-property
  is `all` → error "scope to what changes (transition-colors etc.)".
  Evidence: transition-property.
- `transition-paint-prop`: computed transition-property contains any of
  box-shadow, width, height, top, left, right, bottom, margin*, padding*
  → error "layout/paint props reflow/repaint every frame — focus rings
  SNAP; shadows animate a pseudo-element's opacity". Applies to ALL
  non-exempt elements, not just interactive.
- `transition-too-slow`: interactive element with any computed
  transition-duration > 100ms → error "feedback is ≤100ms (duration-75
  for small controls); the theme default is 100ms, so an explicit
  duration-150+ crept in". Evidence: the duration list + properties.
- `ease-in-feedback`: interactive element whose computed
  transition-timing-function is `ease-in` / `ease-in-out` (or a
  cubic-bezier whose first control point is ease-in-shaped, x1 ≥ 0.4 &&
  y1 < x1/2) → warn "house curve is cubic-bezier(.2,0,.1,1) ease-out".
- `press-instant-rule-missing`: PAGE-LEVEL check (one finding max, not
  per element) — walk document.styleSheets for a rule whose selector
  includes `button:active` and whose style sets `transition-duration: 0s`
  (or `transition: none`). Absent → error "global press-instant rule
  (globals.css §42) missing on this page". Cross-origin sheets that throw
  on .cssRules are skipped silently.

## Tests to add (vitest + happy-dom) — `src/lib/__tests__/slopScan.test.ts`

TEST-RUNNER REALITY: happy-dom has NO layout engine —
`getBoundingClientRect()` returns zeros and `scrollHeight`/`clientHeight`
are 0. Rules that read layout (unvirtualized-scroller, scroll-no-fade,
phantom-fade, scrollbar-flush, row heuristics, focusring-clip,
menu-icon-mixed-weight) are still testable: fixtures stub the metrics via
`Object.defineProperty(el, 'scrollHeight', {value: …, configurable: true})`
and a stubbed `getBoundingClientRect`. Add a tiny `stubMetrics(el, {…})`
test helper and use it in every layout fixture. Rules must read these as
plain property/method access (no destructuring tricks) so stubs apply.
happy-dom DOES apply <style> rules to getComputedStyle for simple
declarations — style-based fixtures set styles inline or via el.style.

For EVERY rule: one positive fixture (violation found, correct evidence)
+ one negative fixture (compliant → no finding). Minimum set:
1. radius-vocabulary: div radius 6px → finding; 8px, 9999px pill, 0 → none.
2. row-radius-token: 3 sibling 28px rows in a scroller, one at 6px → finding.
3. active-fill-token: aria-selected row with #F0F0F1 bg → finding; with
   rgba(0,0,0,0.06) → none.
4. inline-style-state: `.pb-row-action` with style="background:none" →
   finding; layout-only inline style → none.
5. icon-button-no-hover: icon button with no :hover rule → finding; with
   `.pb-row-action` → none.
6. icon-button-no-tooltip: bare icon button → finding; with
   aria-describedby → none.
7. unvirtualized-scroller: 200-child scroller → finding; 20-child → none.
8. scroll-no-fade + phantom-fade: overflowing strip w/o mask → finding;
   masked but non-overflowing → phantom finding; masked+overflow → none.
9. font-family: `font-family: Inter` → finding; Geist → none.
10. uppercase-label: 11px uppercase → finding; 11px none → none.
11. editor-shadow: shadowed panel under [data-editor-surface] → finding;
    hairline `0 0 0 0.5px` ring → none.
12. menu-icons-all-or-none: menu with 2/3 icons → finding; 3/3 & 0/3 → none.
13. cursor-mismatch: button cursor:text → finding.
14. runSlopScan isolation: a rule that throws must not prevent other
    rules' findings (inject a broken rule; assert others still report).
15. Report format: `formatSlopReport(findings)` groups by ruleId with
    counts + selectors — snapshot the exact text shape.
16. transition-all: button with `transition: all 100ms` → finding; with
    `transition: background-color 100ms` → none; a div inside
    [data-slot=popover-content] with transition:all → none (exempt).
17. transition-paint-prop: input transitioning box-shadow → finding;
    transitioning color+border-color only → none; [data-panel] child
    transitioning width → none (exempt).
18. transition-too-slow: button with `transition: background-color 150ms`
    → finding; 100ms → none; 75ms → none.
19. ease-in-feedback: button with `transition-timing-function: ease-in`
    → finding; `cubic-bezier(.2,0,.1,1)` → none.
20. press-instant-rule-missing: document with no `button:active
    { transition-duration: 0s }` stylesheet rule → exactly ONE finding;
    with the rule present → none.

## Wiring notes for the implementing session
- Read `Linear -primitives.md` (path above) BEFORE coding — rule copy
  should quote the section ids (§N / Part N) in `description` so the
  report is traceable back to the contract.
- Reuse the picker/outline utilities from `@/lib/picker` for
  click-to-highlight of a finding.
- Persist last scan per-tab in memory only (no storage).
- Rules must be cheap: one `querySelectorAll("*")` walk max, share the
  walk across rules (pass the element list into every rule).
- Ship with all rules ON; severity filter chips (error/warn) in the panel.
- Performance guard: skip invisible elements early (zero-rect / hidden),
  and lazily cache `getComputedStyle` per element across rules in the
  shared walk — that call is the expensive part on 1000s-node pages.
- Future v2 (leave TODOs): gap-1 pill seams, tabular-nums on live numbers,
  kbd-in-tooltip presence, focus-return-on-close detection (needs event
  instrumentation), two-theme verification via forced color-scheme,
  bridge headless `audit` command (Playwright route sweep, both themes,
  --baseline/--fail-on gate).

## cssSlowdown.ts alignment (same release — §42 is now the contract)

The live/timing engine must agree with §42 or the two auditors contradict:
1. Threshold: flag `duration+delay > 100ms` (was ≥50) — 100ms is the
   blessed house default; a compliant control must produce NO finding.
   Keep the "duration-75 for small controls" wording in suggestions only.
2. `easingViolation`: also flag `ease-in-out` (banned by §42); bezier
   heuristic: x1 ≥ 0.4 && y1 < x1/2 (align with slop-scan rule).
3. Exemptions (both live watcher + audit sweep): skip elements inside
   popover/menu/dialog CONTENT ([data-slot*=content],
   [role=menu|dialog|listbox] ancestors), svg icon micro-motion (target
   is an svg or inside one), and [data-panel] subtree width/height
   transitions — §42 marks these intentional.
4. Shared pure helpers (parseMs, LAYOUT_PAINT_PROPS, easingViolation,
   the exemption predicate) move to `src/lib/cssShared.ts` — imported by
   BOTH cssSlowdown.ts and slopScan.ts so the two can never drift; keep
   slopScan free of bridge/app imports (cssShared must stay pure).
