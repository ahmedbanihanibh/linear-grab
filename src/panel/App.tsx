import { createSignal, createEffect, onCleanup, onMount, For, Show } from 'solid-js';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import DraftView from './views/DraftView';
import CaptureView from './views/CaptureView';
import ActivityView from './views/ActivityView';
import CloudView from './views/CloudView';
import RunningView from './views/RunningView';
import LocalView from './views/LocalView';
import PrsView from './views/PrsView';
import DesignView from './views/DesignView';
import RendersView from './views/RendersView';
import SettingsView from './views/SettingsView';
import { getSettings, saveSettings, subscribeStorage } from '@/lib/storage';
import { subscribeGrabBroadcast } from '@/lib/picker';
import { wireIdbCache } from '@/lib/idbCache';
import { bridgeBase, fetchBridgeHealth, listBridgeTasks, pushBridgeConfig } from '@/lib/bridge';
import { seedFromConfig } from '@/lib/projectConfig';
import { fetchAllAgentSessions } from '@/lib/linear/api';
import { setLinearMediaProxy } from './components/markdown';
import { grabSink, requestedTab, type PanelTab } from './nav';

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'capture', label: 'Capture' },
  { id: 'activity', label: 'Activity' },
  { id: 'running', label: 'Running' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'local', label: 'Local' },
  { id: 'prs', label: 'PRs' },
  { id: 'design', label: 'Design' },
  { id: 'renders', label: 'Renders' },
  { id: 'settings', label: 'Settings' },
];

/* Stuck-agent watchdog: agents that go quiet are invisible failures. Poll
   both executors and raise a browser notification once per condition —
   'needs input' cloud sessions and local sessions silent for 10+ minutes. */
const watchdogNotified = new Set<string>();
function watchdogNotify(key: string, title: string, body: string): void {
  if (watchdogNotified.has(key) || typeof Notification === 'undefined') return;
  watchdogNotified.add(key);
  const fire = () => new Notification(title, { body });
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission === 'default')
    void Notification.requestPermission().then((p) => p === 'granted' && fire());
}
function startWatchdog(): void {
  setInterval(() => {
    void listBridgeTasks()
      .then((tasks) => {
        for (const t of tasks) {
          if (t.status !== 'running') continue;
          const last = t.lastEventAt ?? t.startedAt;
          if (Date.now() - last > 10 * 60_000) {
            watchdogNotify(
              `local-stuck:${t.id}:${last}`,
              'Local agent may be stuck',
              `${t.title.slice(0, 80)} — no output for ${Math.round((Date.now() - last) / 60_000)}m. Nudge or interrupt it in the Local tab.`,
            );
          }
        }
      })
      .catch(() => {});
    void fetchAllAgentSessions()
      .then((sessions) => {
        for (const sn of sessions) {
          if (/awaitingInput|elicit/i.test(sn.status)) {
            watchdogNotify(
              `cloud-input:${sn.id}`,
              'Cloud agent needs input',
              `${sn.issue?.identifier ?? 'Session'} — ${sn.issue?.title?.slice(0, 80) ?? 'a Cursor agent'} is waiting for you.`,
            );
          }
        }
      })
      .catch(() => {});
  }, 60_000);
}
startWatchdog();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

/** Linear brand mark (official logo path). */
export function LinearLogo(props: { size?: number }) {
  return (
    <svg
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden
    >
      <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3541-.0443L12.6587 18.074Z" />
    </svg>
  );
}

export default function App(props: {
  onGrab?: () => void;
  onClose?: () => void;
  /** Page mode: header doubles as the drag handle for the floating panel. */
  onHeaderPointerDown?: (e: PointerEvent) => void;
  /** Page mode: DevTools-style dock-beside-page toggle. */
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const [tab, setTab] = createSignal<PanelTab>('draft');

  const handleGrab = () => {
    void queryClient.invalidateQueries({ queryKey: ['grab'] });
    // Composer picks stay on Activity — the ref lands in the reply text.
    if (grabSink() === 'capture') setTab('capture');
    props.onGrab?.();
  };

  // Deep-link requests from the launcher minimap (page mode).
  createEffect(() => {
    const t = requestedTab();
    if (t) setTab(t);
  });

  onMount(() => {
    // Instant views: hydrate the query cache from IndexedDB, persist updates.
    const cachePromise = wireIdbCache(queryClient);
    const unsubGrab = subscribeGrabBroadcast(handleGrab);
    // Media proxy + bridge auth: lets Linear-hosted images/videos render.
    const syncBridge = () => {
      void bridgeBase().then(setLinearMediaProxy);
      void pushBridgeConfig();
      // Committed .lineargrab.json seeds settings the user hasn't set locally
      // — clone the repo, start the bridge, and the panel arrives configured.
      void fetchBridgeHealth()
        .then(async (h) => {
          if (!h.projectConfig) return;
          const patch = seedFromConfig(await getSettings(), h.projectConfig);
          if (patch) await saveSettings(patch);
        })
        .catch(() => {});
    };
    syncBridge();
    const unsubStorage = subscribeStorage((area) => {
      if (area === 'settings') {
        void queryClient.invalidateQueries({ queryKey: ['settings'] });
        syncBridge();
      }
      if (area === 'grab') handleGrab();
    });
    onCleanup(() => {
      unsubGrab();
      unsubStorage();
      void cachePromise.then((dispose) => dispose());
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <div class="bg-bg text-text flex h-full flex-col">
        <header
          onPointerDown={(e) => props.onHeaderPointerDown?.(e)}
          class={`border-border bg-surface flex shrink-0 items-center gap-1 border-b px-2 py-1.5 select-none ${
            props.onHeaderPointerDown ? 'cursor-grab active:cursor-grabbing' : ''
          }`}
        >
          <span class="text-accent mr-0.5 inline-flex shrink-0" title="Linear Grab">
            <LinearLogo size={14} />
          </span>
          {/* Tab strip scrolls on the x-axis at narrow widths instead of
              colliding with the dock/minimize controls. */}
          <div class="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <For each={TABS}>
              {(t) => (
                <button
                  onClick={() => setTab(t.id)}
                  class={`h-6 shrink-0 rounded-md px-2 text-[12px] font-medium whitespace-nowrap transition-colors ${
                    tab() === t.id
                      ? 'bg-surface-3 text-text'
                      : 'text-text-dim hover:text-text cursor-pointer'
                  }`}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <Show when={props.onTogglePin}>
            <button
              onClick={() => props.onTogglePin?.()}
              aria-label={props.pinned ? 'Switch to overlay' : 'Dock beside page'}
              title={props.pinned ? 'Overlay the page' : 'Dock beside page (squeezes the app, DevTools-style)'}
              class={`hover:bg-surface-3 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md transition-colors ${
                props.pinned ? 'text-accent' : 'text-text-dim hover:text-text'
              }`}
            >
              {/* Dock-to-side glyph */}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                <path d="M10 2.5v11" />
              </svg>
            </button>
          </Show>
          <Show when={props.onClose}>
            <button
              onClick={() => props.onClose?.()}
              aria-label="Minimize to launcher"
              title="Minimize to launcher"
              class="text-text-dim hover:text-text hover:bg-surface-3 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-[15px] leading-none transition-colors"
            >
              –
            </button>
          </Show>
        </header>
        {/* All tabs stay MOUNTED (hidden via CSS): switching tabs never wipes
            in-progress state — your draft note, form fields, scroll positions,
            even a streaming AI draft survive the hop. */}
        <main class="min-h-0 flex-1">
          <div class="h-full" classList={{ hidden: tab() !== 'draft' }}>
            <DraftView onCreated={() => setTab('activity')} />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'capture' }}>
            <CaptureView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'activity' }}>
            <ActivityView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'running' }}>
            <RunningView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'cloud' }}>
            <CloudView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'local' }}>
            <LocalView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'prs' }}>
            <PrsView onOpenIssue={() => setTab('activity')} />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'design' }}>
            <DesignView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'renders' }}>
            <RendersView />
          </div>
          <div class="h-full" classList={{ hidden: tab() !== 'settings' }}>
            <SettingsView />
          </div>
        </main>
      </div>
    </QueryClientProvider>
  );
}
