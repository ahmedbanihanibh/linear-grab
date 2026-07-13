import type { PageMessage, RuntimeMessage } from '@/lib/types';

/**
 * Isolated-world bridge: relays picker events from the MAIN-world script to the
 * extension, and activation requests from the panel back into the page.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    window.addEventListener('message', (event: MessageEvent<PageMessage>) => {
      if (event.source !== window || event.data?.__lineargrab !== true) return;
      if (event.data.type === 'selected' && event.data.elements?.length) {
        chrome.runtime
          .sendMessage({ type: 'grab/selected', payload: event.data.elements } satisfies RuntimeMessage)
          .catch(() => {});
      }
    });

    chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
      if (msg?.type === 'grab/activate') {
        const out: PageMessage = { __lineargrab: true, type: 'activate' };
        window.postMessage(out, '*');
      }
    });
  },
});
