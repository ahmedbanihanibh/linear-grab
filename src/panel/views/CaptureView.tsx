import { createEffect, createSignal, onCleanup, Show, type ParentProps } from 'solid-js';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { getSettings, clearLastGrab, getLastGrab } from '@/lib/storage';
import { activatePicker } from '@/lib/picker';
import {
  getRecorderSnapshot,
  subscribeRecorder,
  startRecording,
  stopRecording,
  discardRecording,
  markRecordingUploaded,
  setRecordingAttach,
} from '@/lib/recorder';
import { uploadFileToLinear } from '@/lib/linear/upload';
import { Button, EmptyState, ErrorNote, Spinner } from '../components/ui';

/** Accordion shell — native <details>, styled like our section headers. */
function Accordion(props: ParentProps<{ title: string; badge?: string }>) {
  return (
    <details open class="group">
      <summary class="text-text-dim hover:text-text flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase select-none">
        <span
          aria-hidden
          class="text-text-faint inline-block w-3 text-center transition-transform group-open:rotate-90"
        >
          ›
        </span>
        {props.title}
        <Show when={props.badge}>
          <span class="text-text-faint ml-auto text-[10.5px] font-normal normal-case tabular-nums">
            {props.badge}
          </span>
        </Show>
      </summary>
      <div class="flex flex-col gap-2 pt-2 pl-4">{props.children}</div>
    </details>
  );
}

/**
 * Capture tab — the "evidence" workspace: picked element (with its highlighted
 * screenshot) and the interaction recording. Both attach to the issue created
 * from the Draft tab.
 */
export default function CaptureView() {
  const queryClient = useQueryClient();

  const grabQuery = createQuery(() => ({ queryKey: ['grab'], queryFn: getLastGrab }));
  const settingsQuery = createQuery(() => ({ queryKey: ['settings'], queryFn: getSettings }));
  const grab = () => grabQuery.data?.[0] ?? null;
  const linearConnected = () =>
    !!(settingsQuery.data?.linearApiKey || settingsQuery.data?.linearAccessToken);

  // ---- element picking ----
  const [pickError, setPickError] = createSignal<string | null>(null);
  const pickElement = () => {
    setPickError(null);
    activatePicker().catch((err: unknown) => {
      setPickError(
        err instanceof Error && err.message
          ? err.message
          : 'Cannot activate the picker — open your dev app in the active tab first.',
      );
    });
  };
  const clearGrab = async () => {
    await clearLastGrab();
    void queryClient.invalidateQueries({ queryKey: ['grab'] });
  };

  // ---- recording ----
  const [rec, setRec] = createSignal(getRecorderSnapshot());
  onCleanup(subscribeRecorder(setRec));

  const [elapsed, setElapsed] = createSignal(0);
  createEffect(() => {
    if (rec().phase !== 'recording') return;
    const iv = setInterval(
      () => setElapsed(Date.now() - (getRecorderSnapshot().startedAt ?? Date.now())),
      250,
    );
    onCleanup(() => clearInterval(iv));
  });
  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const [copyState, setCopyState] = createSignal<'idle' | 'busy' | 'copied'>('idle');
  const [recActionError, setRecActionError] = createSignal<string | null>(null);

  const ensureRecordingUploaded = async (): Promise<string> => {
    const result = getRecorderSnapshot().result;
    if (!result) throw new Error('No recording available.');
    if (result.assetUrl) return result.assetUrl;
    const assetUrl = await uploadFileToLinear(result.blob, `recording-${Date.now()}.gif`);
    markRecordingUploaded(assetUrl);
    return assetUrl;
  };

  const copyRecordingMarkdown = async () => {
    setRecActionError(null);
    setCopyState('busy');
    try {
      const markdownPromise = ensureRecordingUploaded().then(
        (url) => new Blob([`![Screen recording](${url})`], { type: 'text/plain' }),
      );
      try {
        // Safari revokes clipboard access after an await — a ClipboardItem fed
        // a PROMISE is the sanctioned pattern: write starts inside the gesture,
        // content resolves later (after the upload).
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/plain': markdownPromise }),
        ]);
      } catch {
        // Chrome-and-friends fallback (also covers older ClipboardItem support).
        const blob = await markdownPromise;
        await navigator.clipboard.writeText(await blob.text());
      }
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      setCopyState('idle');
      setRecActionError(err instanceof Error ? err.message : 'Copy failed.');
    }
  };

  const downloadRecording = () => {
    const result = rec().result;
    if (!result) return;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = 'linear-grab-recording.gif';
    a.click();
  };

  return (
    <div class="flex h-full flex-col gap-4 overflow-y-auto pt-3 pb-4 pl-3 pr-4">
      {/* ---- Captured element ------------------------------------------------ */}
      <Accordion
        title="Captured element"
        badge={grab()?.componentName ? `<${grab()!.componentName}>` : undefined}
      >
        <Show
          when={grab()}
          fallback={
            <EmptyState title="No element captured">
              Click "Pick element" below, then use the Linear Grab overlay on your
              dev app. Source info is only available in dev builds.
            </EmptyState>
          }
        >
          {(el) => (
            <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
              <div class="flex items-start justify-between gap-2">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <Show when={el().componentName}>
                    <span class="font-mono text-accent text-[12px]">
                      {'<'}{el().componentName}{'>'}
                    </span>
                  </Show>
                  <Show when={el().source?.filePath}>
                    <span class="font-mono text-text-dim break-all text-[11px]">
                      {el().source!.filePath}
                      {el().source?.lineNumber != null ? `:${el().source!.lineNumber}` : ''}
                    </span>
                  </Show>
                  <span class="text-text-faint truncate break-all text-[10.5px]">
                    {el().pageUrl}
                  </span>
                </div>
                <Button class="h-6 shrink-0 px-2 text-[11px]" variant="ghost" onClick={clearGrab}>
                  Clear
                </Button>
              </div>
              <Show when={el().stackContext}>
                <details class="text-[10.5px]">
                  <summary class="text-text-faint cursor-pointer select-none">
                    Component stack
                  </summary>
                  <pre class="font-mono text-text-faint mt-1 overflow-x-auto text-[10.5px] break-all whitespace-pre-wrap">
                    {el().stackContext}
                  </pre>
                </details>
              </Show>
              <Show when={el().screenshotDataUrl}>
                <img
                  src={el().screenshotDataUrl}
                  alt="Element location screenshot"
                  class="border-border bg-bg max-h-40 w-full rounded-md border object-contain"
                />
                <span class="text-text-faint text-[10.5px]">
                  Highlighted screenshot — attached to the issue on create.
                </span>
              </Show>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-1.5">
          <Button variant="primary" onClick={pickElement}>
            Pick element
          </Button>
          <Show when={pickError()}>
            <ErrorNote message={pickError()!} />
          </Show>
        </div>
      </Accordion>

      {/* ---- Recording -------------------------------------------------------- */}
      <Accordion
        title="Recording"
        badge={
          rec().result ? `${(rec().result!.durationMs / 1000).toFixed(1)}s` : undefined
        }
      >
        <Show when={rec().phase === 'idle' || rec().phase === 'error'}>
          <div class="flex flex-col gap-1.5">
            <Button variant="ghost" onClick={() => void startRecording()}>
              <span class="text-danger">●</span> Record interaction
            </Button>
            <span class="text-text-faint text-[10.5px] leading-snug">
              Captures your screen as a looping GIF (max 30s) the coding agent can
              watch. Pick this tab in the share dialog, then reproduce the issue.
            </span>
            <Show when={rec().phase === 'error' && rec().error}>
              <ErrorNote message={rec().error!} />
            </Show>
          </div>
        </Show>

        <Show when={rec().phase === 'recording'}>
          <div class="bg-surface border-border flex items-center gap-2 rounded-lg border p-2.5">
            <span aria-hidden class="bg-danger size-2 shrink-0 animate-pulse rounded-full" />
            <span class="text-text min-w-[5ch] text-[12px] tabular-nums">
              {formatElapsed(elapsed())}
            </span>
            <span class="text-text-faint text-[10.5px]">max 0:30</span>
            <Button variant="primary" class="ml-auto" onClick={() => void stopRecording()}>
              <span class="inline-block min-w-[4ch] text-center">Stop</span>
            </Button>
          </div>
        </Show>

        <Show when={rec().phase === 'processing'}>
          <div class="bg-surface border-border flex items-center gap-2 rounded-lg border p-2.5">
            <Spinner />
            <span class="text-text-dim text-[12px]">Encoding GIF…</span>
          </div>
        </Show>

        <Show when={rec().phase === 'ready' && rec().result}>
          {(result) => (
            <div class="bg-surface border-border flex flex-col gap-2 rounded-lg border p-2.5">
              <img
                src={result().url}
                alt="Screen recording preview"
                class="border-border bg-bg max-h-44 w-full rounded-md border object-contain"
              />
              <span class="text-text-faint text-[10.5px] tabular-nums">
                {(result().blob.size / 1024).toFixed(0)} KB ·{' '}
                {(result().durationMs / 1000).toFixed(1)}s · {result().width}×
                {result().height}
              </span>
              <label class="flex cursor-pointer items-center gap-2 select-none">
                <input
                  type="checkbox"
                  checked={rec().attachOnCreate}
                  onChange={(e) => setRecordingAttach(e.currentTarget.checked)}
                  class="accent-accent rounded"
                />
                <span class="text-text text-[12px]">Attach to issue on create</span>
              </label>
              <div class="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  class="h-6 px-2 text-[11px]"
                  loading={copyState() === 'busy'}
                  disabled={!linearConnected()}
                  title={
                    linearConnected()
                      ? 'Uploads to Linear and copies embeddable markdown'
                      : 'Connect Linear in Settings first'
                  }
                  onClick={() => void copyRecordingMarkdown()}
                >
                  <span class="inline-block min-w-[9ch] text-center">
                    {copyState() === 'copied' ? 'Copied!' : 'Copy markdown'}
                  </span>
                </Button>
                <Button variant="ghost" class="h-6 px-2 text-[11px]" onClick={downloadRecording}>
                  Download
                </Button>
                <Button
                  variant="danger"
                  class="ml-auto h-6 px-2 text-[11px]"
                  onClick={discardRecording}
                >
                  Discard
                </Button>
              </div>
              <Show when={recActionError()}>
                <ErrorNote message={recActionError()!} />
              </Show>
            </div>
          )}
        </Show>
      </Accordion>
    </div>
  );
}
