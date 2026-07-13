import { isExtensionContext } from './env';
import { NoProviderError } from './ai/providers';
import type {
  AiProvider,
  DraftInput,
  DraftPortClientMessage,
  DraftPortServerMessage,
  IssueDraft,
} from './types';

export interface DraftHandlers {
  onPartial: (draft: Partial<IssueDraft>) => void;
  onDone: (result: {
    draft: IssueDraft;
    provider: AiProvider;
    modelId: string;
    fellBack: boolean;
  }) => void;
  onError: (message: string, code?: 'no-provider' | 'unknown') => void;
}

/**
 * Transport-agnostic draft streaming for the panel. Returns a cancel function.
 * Extension: proxied to the service worker over a port (key stays in the worker,
 * stream survives panel close). Page mode: runs in-process — works in Safari,
 * Firefox, any browser.
 */
export function startDraftStream(input: DraftInput, handlers: DraftHandlers): () => void {
  return isExtensionContext
    ? startViaPort(input, handlers)
    : startInProcess(input, handlers);
}

function startViaPort(input: DraftInput, handlers: DraftHandlers): () => void {
  const port = chrome.runtime.connect({ name: 'ai-draft' });
  let settled = false;

  port.onMessage.addListener((msg: DraftPortServerMessage) => {
    if (msg.type === 'partial') {
      handlers.onPartial(msg.draft);
    } else if (msg.type === 'done') {
      settled = true;
      handlers.onDone(msg);
      port.disconnect();
    } else if (msg.type === 'error') {
      settled = true;
      handlers.onError(msg.message, msg.code === 'no-provider' ? 'no-provider' : 'unknown');
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (!settled) handlers.onError('Draft stream disconnected.');
  });

  port.postMessage({ type: 'start', input } satisfies DraftPortClientMessage);

  return () => {
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
  };
}

function startInProcess(input: DraftInput, handlers: DraftHandlers): () => void {
  const abort = new AbortController();

  void (async () => {
    // Dynamic import keeps the AI SDK out of hosts that never draft.
    const { executeDraft } = await import('./ai/draft');
    try {
      const result = await executeDraft(input, handlers.onPartial, abort.signal);
      if (!abort.signal.aborted) handlers.onDone(result);
    } catch (err) {
      if (abort.signal.aborted) return;
      handlers.onError(
        err instanceof Error ? err.message : String(err),
        err instanceof NoProviderError ? 'no-provider' : 'unknown',
      );
    }
  })();

  return () => abort.abort();
}
