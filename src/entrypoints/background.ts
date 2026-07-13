import { executeDraft } from '@/lib/ai/draft';
import { NoProviderError } from '@/lib/ai/providers';
import { mergeGrabs } from '@/lib/storage';
import type {
  DraftPortClientMessage,
  DraftPortServerMessage,
  RuntimeMessage,
} from '@/lib/types';

export default defineBackground(() => {
  // Toolbar icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    if (msg?.type === 'grab/selected') {
      void mergeGrabs(msg.payload).then(() => {
        // Panel (if open) invalidates its grab query on this.
        chrome.runtime.sendMessage({ type: 'grab/updated' } satisfies RuntimeMessage).catch(() => {});
      });
      return;
    }
    if (msg?.type === 'grab/activate') {
      void activatePickerOnActiveTab().then(
        () => sendResponse({ ok: true }),
        (err: unknown) => sendResponse({ ok: false, error: String(err) }),
      );
      return true; // async response
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'ai-draft') handleDraftPort(port);
  });
});

async function activatePickerOnActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  await chrome.tabs.sendMessage(tab.id, { type: 'grab/activate' } satisfies RuntimeMessage);
}

/**
 * Extension transport for the shared draft engine: runs in the worker so the
 * key never leaves it and the stream survives the panel closing mid-generation.
 */
function handleDraftPort(port: chrome.runtime.Port): void {
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());

  const send = (m: DraftPortServerMessage) => {
    try {
      port.postMessage(m);
    } catch {
      // Port closed — the abort signal ends the stream.
    }
  };

  port.onMessage.addListener((msg: DraftPortClientMessage) => {
    if (msg?.type !== 'start') return;
    void executeDraft(msg.input, (draft) => send({ type: 'partial', draft }), abort.signal)
      .then((result) => send({ type: 'done', ...result }))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          code: err instanceof NoProviderError ? 'no-provider' : 'unknown',
        });
      });
  });
}
