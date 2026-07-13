import { init, getGlobalApi, registerPlugin } from 'react-grab';
import { createSelectionPipeline } from '@/lib/picker';
import type { GrabbedElement, PageMessage } from '@/lib/types';

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

    const pipeline = createSelectionPipeline((elements: GrabbedElement[]) => {
      const msg: PageMessage = { __lineargrab: true, type: 'selected', elements };
      window.postMessage(msg, '*');
    });

    const ensureStarted = () => {
      if (started) return;
      started = true;
      try {
        init();
        registerPlugin(pipeline.plugin);
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
    // WindowEventMap. The pipeline publishes instantly, then again with the
    // element screenshot once captured.
    window.addEventListener('react-grab:element-selected', (event) => {
      pipeline.handleSelection(event.detail.elements ?? []);
    });
  },
});
