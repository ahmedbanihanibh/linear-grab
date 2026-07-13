import { isExtensionContext } from './env';
import { setLastGrab } from './storage';
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
    rg.init();
  } catch {
    pageStarted = false;
    return;
  }
  window.addEventListener('react-grab:element-selected', (event) => {
    const elements = (event.detail.elements ?? []).map(mapSelectedElement);
    if (elements.length) void setLastGrab(elements);
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
