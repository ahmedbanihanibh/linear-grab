import { isExtensionContext } from './env';
import { setLastGrab } from './storage';
import { captureElementShot, prewarmCapture } from './elementShot';
import type { GrabbedElement, RuntimeMessage } from './types';

/**
 * react-grab's SelectedElementPayload is FLAT:
 * { tagName, id?, className?, textContent?, componentName?, filePath?, lineNumber?, columnNumber? }
 * (react-grab@0.1.48). Shared by the extension MAIN-world script and page mode.
 */
export function mapSelectedElement(el: {
  tagName?: string;
  textContent?: string;
  componentName?: string;
  filePath?: string;
  lineNumber?: number;
  columnNumber?: number;
}): GrabbedElement {
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
    grabbedAt: Date.now(),
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

  return {
    plugin: {
      name: 'linear-grab',
      hooks: {
        onElementSelect: (element: Element) => {
          pendingShot = captureElementShot(element);

          // Pass 1: instant publish — no waiting on react-grab's copy flow.
          const api = getApi?.();
          const immediate: GrabbedElement = {
            tagName: element.tagName?.toLowerCase() || undefined,
            componentName: api?.getDisplayName?.(element) || undefined,
            content: (element.textContent ?? '').slice(0, 500),
            source: null,
            stackContext: undefined,
            pageUrl: location.href,
            grabbedAt: Date.now(),
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
      const elements = payloads.map(mapSelectedElement);
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
    // One dock: hide react-grab's own toolbar — our launcher pill carries the
    // pick button, agent status, and recording controls instead.
    rg.init({ toolbar: { show: false } } as Parameters<typeof rg.init>[0]);
  } catch {
    pageStarted = false;
    return;
  }
  const pipeline = createSelectionPipeline(
    (els) => void setLastGrab(els),
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
