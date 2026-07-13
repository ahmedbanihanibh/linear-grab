import { init, getGlobalApi } from 'react-grab';
import { mapSelectedElement } from '@/lib/picker';
import type { PageMessage } from '@/lib/types';

/**
 * MAIN-world script: must run in the page's JS world to reach React fiber internals
 * (`__reactFiber$…` props). Talks to the extension only through window.postMessage —
 * the isolated-world bridge relays to chrome.runtime.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    let started = false;

    const ensureStarted = () => {
      if (started) return;
      started = true;
      try {
        init();
      } catch {
        started = false;
      }
    };

    // Panel → bridge → here: user hit "Pick element".
    window.addEventListener('message', (event: MessageEvent<PageMessage>) => {
      if (event.source !== window || event.data?.__lineargrab !== true) return;
      if (event.data.type === 'activate') {
        ensureStarted();
        // Typed accessor from react-grab — no window global cast needed.
        getGlobalApi()?.activate();
      }
    });

    // react-grab dispatches this on every selection; its typings augment
    // WindowEventMap, so `event.detail.elements` is fully typed.
    window.addEventListener('react-grab:element-selected', (event) => {
      const elements = (event.detail.elements ?? []).map(mapSelectedElement);
      if (!elements.length) return;
      const msg: PageMessage = { __lineargrab: true, type: 'selected', elements };
      window.postMessage(msg, '*');
    });
  },
});
