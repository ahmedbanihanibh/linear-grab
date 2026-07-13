import { render } from 'solid-js/web';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import App from '@/panel/App';
import { ensurePagePicker } from '@/lib/picker';
import { subscribeStorage } from '@/lib/storage';
// Compiled Tailwind CSS as a string — injected into the shadow root so the
// host app's styles and ours never collide.
import cssText from '@/styles/app.css?inline';

export interface InitOptions {
  /** Open the panel immediately instead of waiting for the launcher click. */
  defaultOpen?: boolean;
}

declare global {
  interface Window {
    __LINEAR_GRAB_PAGE__?: boolean;
  }
}

/**
 * Page-mode entry — the react-grab distribution model. Add to any project:
 *
 *   if (import.meta.env.DEV) {
 *     import('linear-grab').then(({ init }) => init());
 *   }
 *
 * Mounts the full panel (draft / activity / settings) in a shadow root inside
 * the host app. Works in ANY browser — Safari, Firefox, Chrome. Dev use only:
 * keys are stored in localStorage of the dev origin.
 */
export function init(options: InitOptions = {}): void {
  if (typeof window === 'undefined') return; // SSR guard
  if (window.__LINEAR_GRAB_PAGE__) return; // double-init guard
  window.__LINEAR_GRAB_PAGE__ = true;

  const mount = () => {
    void ensurePagePicker();

    const host = document.createElement('div');
    host.id = 'linear-grab-root';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);

    const root = document.createElement('div');
    shadow.appendChild(root);

    render(() => <PagePanel defaultOpen={options.defaultOpen ?? false} />, root);
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

/** Floating launcher + slide-in panel hosting the shared App. */
function PagePanel(props: { defaultOpen: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen);

  // App unmounts while closed (so Activity polling stops) — this outer
  // subscription re-opens the panel when a new grab lands.
  onMount(() => {
    const unsub = subscribeStorage((area) => {
      if (area === 'grab') setOpen(true);
    });
    onCleanup(unsub);
  });

  return (
    <>
      {/* Launcher — fixed size in both states so it never shifts. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open() ? 'Close Linear Grab' : 'Open Linear Grab'}
        title="Linear Grab"
        class="bg-accent hover:bg-accent-hover fixed right-4 bottom-4 z-[2147483646] grid size-10 cursor-pointer place-items-center rounded-full text-white shadow-lg transition-colors"
        style={{ 'font-family': 'var(--font-sans)' }}
      >
        <span class="inline-block w-[14px] text-center text-[13px] leading-none font-semibold">
          {open() ? '×' : 'LG'}
        </span>
      </button>

      <Show when={open()}>
        <div class="bg-bg border-border text-text font-sans fixed top-0 right-0 z-[2147483645] flex h-screen w-[380px] max-w-[100vw] flex-col border-l text-[13px] antialiased shadow-2xl">
          {/* New grab captured → make sure the panel is visible. */}
          <App onGrab={() => setOpen(true)} />
        </div>
      </Show>
    </>
  );
}
