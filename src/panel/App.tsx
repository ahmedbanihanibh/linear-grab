import { createSignal, onCleanup, onMount, Match, Switch, For } from 'solid-js';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import DraftView from './views/DraftView';
import ActivityView from './views/ActivityView';
import SettingsView from './views/SettingsView';
import { subscribeStorage } from '@/lib/storage';
import { subscribeGrabBroadcast } from '@/lib/picker';

type Tab = 'draft' | 'activity' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

export default function App(props: { onGrab?: () => void }) {
  const [tab, setTab] = createSignal<Tab>('draft');

  const handleGrab = () => {
    void queryClient.invalidateQueries({ queryKey: ['grab'] });
    setTab('draft');
    props.onGrab?.();
  };

  onMount(() => {
    // A new grab lands while the panel is open → refresh + jump to Draft.
    // (Extension: runtime broadcast. Page mode: covered by the storage sub below.)
    const unsubGrab = subscribeGrabBroadcast(handleGrab);

    // Storage changed (settings edited anywhere, or a grab written in page mode).
    const unsubStorage = subscribeStorage((area) => {
      if (area === 'settings') void queryClient.invalidateQueries({ queryKey: ['settings'] });
      if (area === 'grab') handleGrab();
    });

    onCleanup(() => {
      unsubGrab();
      unsubStorage();
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <div class="flex h-screen flex-col">
        <header class="border-border bg-surface flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
          <For each={TABS}>
            {(t) => (
              <button
                onClick={() => setTab(t.id)}
                class={`h-6 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  tab() === t.id
                    ? 'bg-surface-3 text-text'
                    : 'text-text-dim hover:text-text cursor-pointer'
                }`}
              >
                {t.label}
              </button>
            )}
          </For>
        </header>
        <main class="min-h-0 flex-1">
          <Switch>
            <Match when={tab() === 'draft'}>
              <DraftView onCreated={() => setTab('activity')} />
            </Match>
            <Match when={tab() === 'activity'}>
              <ActivityView />
            </Match>
            <Match when={tab() === 'settings'}>
              <SettingsView />
            </Match>
          </Switch>
        </main>
      </div>
    </QueryClientProvider>
  );
}
