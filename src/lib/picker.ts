import { isExtensionContext } from './env';
import { getSettings, mergeGrabs } from './storage';
import { captureElementShot, prewarmCapture } from './elementShot';
import { buildLocalContext } from './ai/prompt';
import type { GrabbedElement, RuntimeMessage } from './types';

/** Fired on window after a local-mode auto-copy so the pill can flash "Copied". */
export const CONTEXT_COPIED_EVENT = 'linear-grab:context-copied';

/** Fired when the picker activates — the panel minimizes so the page is clear
    for hovering/selecting (same choreography as recording). */
export const PICKER_ACTIVATED_EVENT = 'linear-grab:picker-activated';
/** Fired when an interactive capture ENDS (success, cancel, or failure) —
    the panel reopens on this, so a hung/failed capture can never strand the
    UI closed. */
export const PICKER_FINISHED_EVENT = 'linear-grab:picker-finished';

// Local-workflow auto-copy: at most once per grab, preferring the pass that
// carries source info; falls back to a source-less copy shortly after (prod
// builds have no fiber debug data).
let lastCopiedGrabAt = 0;
let pendingFallback: ReturnType<typeof setTimeout> | null = null;

function maybeLocalCopy(el: GrabbedElement | undefined): void {
  if (!el || el.grabbedAt === lastCopiedGrabAt) return;
  void getSettings().then((settings) => {
    if (settings.workflowMode !== 'local') return;
    if (el.grabbedAt === lastCopiedGrabAt) return;
    const doCopy = () => {
      lastCopiedGrabAt = el.grabbedAt;
      navigator.clipboard
        .writeText(buildLocalContext(el, settings))
        .then(() => window.dispatchEvent(new CustomEvent(CONTEXT_COPIED_EVENT)))
        .catch(() => {
          lastCopiedGrabAt = 0; // gesture expired — the Capture tab button still works
        });
    };
    if (el.source?.filePath) {
      if (pendingFallback) clearTimeout(pendingFallback);
      pendingFallback = null;
      doCopy();
    } else {
      // Wait briefly for the source-enriched pass; copy without it otherwise.
      if (pendingFallback) clearTimeout(pendingFallback);
      pendingFallback = setTimeout(doCopy, 900);
    }
  });
}

/**
 * react-grab's SelectedElementPayload is FLAT:
 * { tagName, id?, className?, textContent?, componentName?, filePath?, lineNumber?, columnNumber? }
 * (react-grab@0.1.48). Shared by the extension MAIN-world script and page mode.
 */
export function mapSelectedElement(
  el: {
    tagName?: string;
    textContent?: string;
    componentName?: string;
    filePath?: string;
    lineNumber?: number;
    columnNumber?: number;
  },
  grabbedAt: number = Date.now(),
): GrabbedElement {
  return {
    tagName: el.tagName || undefined,
    componentName: el.componentName || undefined,
    content: el.textContent ? el.textContent.slice(0, 500) : '',
    source: el.filePath
      ? {
          filePath: el.filePath,
          lineNumber: el.lineNumber ?? null,
          columnNumber: el.columnNumber ?? null,
          componentName: el.componentName ?? null,
        }
      : null,
    stackContext: undefined,
    pageUrl: location.href,
    grabbedAt,
  };
}

/** The subset of react-grab's global API the pipeline uses for instant capture. */
export interface PickerApi {
  getDisplayName?: (el: Element) => string | null;
  getSource?: (el: Element) => Promise<{
    filePath?: string | null;
    lineNumber?: number | null;
    columnNumber?: number | null;
    componentName?: string | null;
  } | null>;
}

/**
 * Selection pipeline shared by both hosts (page mode and the extension's
 * MAIN-world script). Publishing happens in escalating passes so the panel
 * reacts THE INSTANT the user clicks:
 *   1. onElementSelect (synchronous click) → tag/component/text immediately
 *   2. getSource resolves (~ms)           → + file:line
 *   3. react-grab's copy-flow event       → authoritative flat payload
 *   4. screenshot resolves (~0.5s idle)   → + highlighted context image
 */
export function createSelectionPipeline(
  publish: (els: GrabbedElement[]) => void,
  getApi?: () => PickerApi | null | undefined,
) {
  let pendingShot: Promise<string | null> | null = null;
  let lastPickAt = 0;

  return {
    plugin: {
      name: 'linear-grab',
      hooks: {
        onElementSelect: (element: Element) => {
          lastPickAt = Date.now();

          // Screenshots are OPT-IN: the DOM capture is the one costly step,
          // so default picking stays react-grab fast.
          pendingShot = getSettings().then((s) =>
            s.captureShots ? captureElementShot(element) : null,
          );

          // Pass 1: instant publish — no waiting on react-grab's copy flow.
          const api = getApi?.();
          const immediate: GrabbedElement = {
            tagName: element.tagName?.toLowerCase() || undefined,
            componentName: api?.getDisplayName?.(element) || undefined,
            content: (element.textContent ?? '').slice(0, 500),
            source: null,
            stackContext: undefined,
            pageUrl: location.href,
            grabbedAt: lastPickAt,
          };
          publish([immediate]);

          // Pass 2: source resolution (fiber walk — fast, but async).
          try {
            void api?.getSource?.(element)?.then((src) => {
              if (!src?.filePath) return;
              publish([
                {
                  ...immediate,
                  source: {
                    filePath: src.filePath,
                    lineNumber: src.lineNumber ?? null,
                    columnNumber: src.columnNumber ?? null,
                    componentName: src.componentName ?? immediate.componentName ?? null,
                  },
                },
              ]);
            });
          } catch {
            /* source is best-effort */
          }
        },
      },
    },
    handleSelection(payloads: Array<Parameters<typeof mapSelectedElement>[0]>) {
      // Pass 3: react-grab's own event payload (authoritative when it fires).
      // The first element reuses pass 1's id so the merge updates in place;
      // multi-select extras get unique sequential ids.
      const base = lastPickAt && Date.now() - lastPickAt < 4_000 ? lastPickAt : Date.now();
      const elements = payloads.map((p, i) => mapSelectedElement(p, base + i));
      if (!elements.length) return;
      publish(elements);
      const shot = pendingShot;
      pendingShot = null;
      if (shot) {
        // Pass 4: highlighted screenshot.
        void shot.then((dataUrl) => {
          if (dataUrl) {
            publish([{ ...elements[0], screenshotDataUrl: dataUrl }, ...elements.slice(1)]);
          }
        });
      }
    },
  };
}

let pageStarted = false;

/**
 * Page mode: boot react-grab in the host app and pipe every selection into
 * storage (which notifies the panel). Idempotent. No-op in extension context
 * (there the MAIN-world content script owns this).
 */
export async function ensurePagePicker(): Promise<void> {
  if (isExtensionContext || pageStarted) return;
  pageStarted = true;
  const rg = await import('react-grab');
  try {
    // react-grab's own toolbar IS the picker UI — it's the fast, familiar
    // path. Our pill carries panel/agent/recording concerns only.
    rg.init();
  } catch {
    pageStarted = false;
    return;
  }
  const pipeline = createSelectionPipeline(
    (els) => {
      void mergeGrabs(els); // multi-element: picks accumulate into one issue
      maybeLocalCopy(els[0]); // react-grab workflow: pick = context on clipboard
    },
    () => rg.getGlobalApi() as PickerApi | null,
  );
  rg.registerPlugin(pipeline.plugin);
  prewarmCapture(); // one-time capture costs paid at idle, not on first pick
  window.addEventListener('react-grab:element-selected', (event) => {
    pipeline.handleSelection(event.detail.elements ?? []);
  });
}

/** Activate the element picker overlay, whichever host we're in. */
export async function activatePicker(): Promise<void> {
  if (isExtensionContext) {
    const response = (await chrome.runtime.sendMessage({
      type: 'grab/activate',
    } satisfies RuntimeMessage)) as { ok: boolean; error?: string } | undefined;
    if (response && response.ok === false) {
      throw new Error(response.error ?? 'Cannot activate the picker on this page.');
    }
    return;
  }
  await ensurePagePicker();
  const rg = await import('react-grab');
  window.dispatchEvent(new CustomEvent(PICKER_ACTIVATED_EVENT));
  rg.getGlobalApi()?.activate();
}

/**
 * Notify when a new grab lands (panel refreshes + switches to Draft).
 * Extension: runtime broadcast from the background. Page: covered by the
 * storage emitter ('grab' area), so this only wires the extension channel.
 */
export function subscribeGrabBroadcast(cb: () => void): () => void {
  if (!isExtensionContext) return () => {};
  const listener = (msg: RuntimeMessage) => {
    if (msg?.type === 'grab/updated') cb();
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
