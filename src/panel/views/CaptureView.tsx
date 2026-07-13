import { createEffect, createSignal, onCleanup, For, Show, type ParentProps } from 'solid-js';
import type { GrabbedElement } from '@/lib/types';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { getSettings, clearLastGrab, getLastGrab, mergeGrabs, removeGrab } from '@/lib/storage';
import { activatePicker, PICKER_ACTIVATED_EVENT } from '@/lib/picker';
import { captureRegionInteractive } from '@/lib/regionCapture';
import { isExtensionContext } from '@/lib/env';
import {
  getRecorderSnapshot,
  subscribeRecorder,
  startRecording,
  stopRecording,
  discardRecording,
  markRecordingUploaded,
  setRecordingAttach,
} from '@/lib/recorder';
import { uploadAsset } from '@/lib/assetUpload';
import { buildLocalContext } from '@/lib/ai/prompt';
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
  const grabs = () => grabQuery.data ?? [];
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

  // react-grab workflow: copy an element's context for a LOCAL agent
  // (Claude Code / Cursor chat) — includes the project's skills/memory paths.
  const [copiedId, setCopiedId] = createSignal<number | null>(null);
  const copyContext = async (el: GrabbedElement) => {
    try {
      await navigator.clipboard.writeText(buildLocalContext(el, settingsQuery.data ?? {}));
      setCopiedId(el.grabbedAt);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setPickError('Clipboard was blocked — click the button again.');
    }
  };

  const dropGrab = async (grabbedAt: number) => {
    await removeGrab(grabbedAt);
    void queryClient.invalidateQueries({ queryKey: ['grab'] });
  };

  // Custom region capture: minimize (overlay mode), drag a rectangle, and the
  // shot joins the capture list — attached to the issue for either executor.
  const [regionBusy, setRegionBusy] = createSignal(false);
  const captureRegion = async () => {
    setPickError(null);
    setRegionBusy(true);
    window.dispatchEvent(new CustomEvent(PICKER_ACTIVATED_EVENT)); // panel out of the way
    try {
      const shot = await captureRegionInteractive();
      if (shot) {
        await mergeGrabs([shot]); // reopens the panel on Capture (cloud mode)
      } else {
        setPickError('Region capture failed — try a smaller area, or it was cancelled. The exact error is in the browser console ([linear-grab]).');
      }
    } finally {
      setRegionBusy(false);
    }
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
    // A hung upload (bridge down mid-request, slow fallback chain) left the
    // button spinning forever — cap it so the GIF-copy fallback can kick in.
    const assetUrl = await Promise.race([
      uploadAsset(result.blob, `recording-${Date.now()}.gif`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('upload timed out')), 60_000),
      ),
    ]);
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
    } catch {
      // Direct upload blocked (Linear storage rejects cross-origin browser
      // uploads) — degrade to copying the GIF itself, which paste-uploads.
      setCopyState('idle');
      await copyGif();
      setRecActionError(
        'Direct upload is blocked in this browser — copied the GIF instead. Paste it into a Linear comment and Linear uploads it.',
      );
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

  // Copy the GIF binary itself — paste into a Linear comment and LINEAR does
  // the upload (works even when direct browser upload is CORS-blocked).
  const [gifCopyState, setGifCopyState] = createSignal<'idle' | 'busy' | 'copied'>('idle');
  const copyGif = async () => {
    const result = rec().result;
    if (!result) return;
    setRecActionError(null);
    setGifCopyState('busy');
    try {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/gif': result.blob })]);
      } catch {
        // Most browsers only allow PNG on the clipboard — fall back to the
        // first frame as a still (Download keeps the animation).
        const bitmap = await createImageBitmap(result.blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        const png = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'),
        );
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        setRecActionError(
          'Browser blocks GIF clipboard — copied the first frame as PNG. Use Download for the animation.',
        );
      }
      setGifCopyState('copied');
      setTimeout(() => setGifCopyState('idle'), 2000);
    } catch (err) {
      setGifCopyState('idle');
      setRecActionError(err instanceof Error ? err.message : 'Copy failed.');
    }
  };

  return (
    <div class="flex h-full flex-col gap-4 overflow-y-auto pt-3 pb-4 pl-3 pr-4">
      {/* ---- Captured element ------------------------------------------------ */}
      <Accordion
        title="Captured elements"
        badge={grabs().length ? `${grabs().length}/8` : undefined}
      >
        <Show
          when={grabs().length > 0}
          fallback={
            <EmptyState title="No elements captured">
              Click "Pick element" below, then use the react-grab overlay on your
              dev app. Every pick ADDS to this list — Shift+click or drag in the
              overlay selects several at once. Source info needs a dev build.
            </EmptyState>
          }
        >
          <div class="flex flex-col gap-1.5">
            <For each={grabs()}>
              {(el) => (
                <div class="bg-surface border-border flex flex-col gap-1.5 rounded-lg border p-2.5">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-mono text-accent min-w-0 truncate text-[12px]">
                      {el.componentName
                        ? `<${el.componentName}>`
                        : el.tagName
                          ? `<${el.tagName}>`
                          : 'Element'}
                    </span>
                    <div class="flex shrink-0 items-center gap-1">
                      <Button
                        class="size-7 px-0"
                        variant="ghost"
                        title="Copy context for a local agent (Claude Code / Cursor) — includes skills & memory paths"
                        aria-label="Copy context"
                        onClick={() => void copyContext(el)}
                      >
                        <Show
                          when={copiedId() === el.grabbedAt}
                          fallback={
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden>
                              <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
                              <path d="M10.5 5.5v-2a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" />
                            </svg>
                          }
                        >
                          <span class="text-success text-[12px] leading-none">✓</span>
                        </Show>
                      </Button>
                      <Button
                        class="size-7 px-0"
                        variant="ghost"
                        title="Remove this element"
                        aria-label="Remove element"
                        onClick={() => void dropGrab(el.grabbedAt)}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </Button>
                    </div>
                  </div>
                  <Show when={el.source?.filePath}>
                    <span class="font-mono text-text-dim break-all text-[11px] leading-snug">
                      {el.source!.filePath}
                      {el.source?.lineNumber != null ? `:${el.source!.lineNumber}` : ''}
                    </span>
                  </Show>
                  <Show when={el.screenshotDataUrl}>
                    <img
                      src={el.screenshotDataUrl}
                      alt="Element location screenshot"
                      class="border-border bg-bg max-h-32 w-full rounded-md border object-contain"
                    />
                  </Show>
                </div>
              )}
            </For>
            <Show
              when={
                new Set(
                  grabs()
                    .filter((g) => g.source?.filePath)
                    .map((g) => `${g.source!.filePath}:${g.source!.lineNumber ?? ''}`),
                ).size < grabs().filter((g) => g.source?.filePath).length
              }
            >
              <p class="text-warn text-[10.5px] leading-snug">
                Several captures resolve to the same source — this page region
                likely renders inside an iframe/canvas the picker can't see
                into. Use <b>Capture region</b> for visual pointers there.
              </p>
            </Show>
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-faint min-w-0 text-[10.5px] leading-snug">
                All elements post into ONE issue. Shift+click / drag selects several at once.
              </span>
              <Button class="h-6 shrink-0 px-2 text-[11px]" variant="ghost" onClick={clearGrab}>
                Clear all
              </Button>
            </div>
          </div>
        </Show>

        <div class="flex flex-col gap-1.5">
          <div class="flex gap-1.5">
            <Button variant="primary" class="min-w-0 flex-1" onClick={pickElement}>
              Pick element
            </Button>
            <Show when={!isExtensionContext}>
              <Button
                variant="ghost"
                class="min-w-0 flex-1"
                loading={regionBusy()}
                title="Drag a rectangle over any part of the page — the shot attaches to the issue"
                onClick={() => void captureRegion()}
              >
                Capture region
              </Button>
            </Show>
          </div>
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
              {/* Icon actions — fixed-size squares with tooltips, so the row
                  never overflows at the panel's minimum width. */}
              <div class="flex items-center gap-1">
                <Button
                  variant="ghost"
                  class="size-7 px-0"
                  loading={copyState() === 'busy'}
                  disabled={!linearConnected()}
                  title={
                    linearConnected()
                      ? 'Copy markdown — uploads to Linear, copies embeddable link'
                      : 'Connect Linear in Settings first'
                  }
                  aria-label="Copy markdown"
                  onClick={() => void copyRecordingMarkdown()}
                >
                  <Show
                    when={copyState() === 'copied'}
                    fallback={
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                        <path d="M6.5 9.5 9.5 6.5M7.5 4.5 9 3a2.5 2.5 0 0 1 3.5 3.5L11 8M8.5 11.5 7 13a2.5 2.5 0 0 1-3.5-3.5L5 8" />
                      </svg>
                    }
                  >
                    <span class="text-success text-[12px] leading-none">✓</span>
                  </Show>
                </Button>
                <Button
                  variant="ghost"
                  class="size-7 px-0"
                  loading={gifCopyState() === 'busy'}
                  title="Copy GIF — paste into a Linear comment and Linear uploads it"
                  aria-label="Copy GIF"
                  onClick={() => void copyGif()}
                >
                  <Show
                    when={gifCopyState() === 'copied'}
                    fallback={
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden>
                        <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
                        <path d="M10.5 5.5v-2a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" />
                      </svg>
                    }
                  >
                    <span class="text-success text-[12px] leading-none">✓</span>
                  </Show>
                </Button>
                <Button
                  variant="ghost"
                  class="size-7 px-0"
                  title="Download GIF"
                  aria-label="Download GIF"
                  onClick={downloadRecording}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden>
                    <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M2.5 13.5h11" />
                  </svg>
                </Button>
                <Button
                  variant="danger"
                  class="ml-auto size-7 px-0"
                  title="Discard recording"
                  aria-label="Discard recording"
                  onClick={discardRecording}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden>
                    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1.5 1.5 0 0 0 1.5 1.4h3.6A1.5 1.5 0 0 0 11.3 13l.7-9M6.5 7v4.5M9.5 7v4.5" />
                  </svg>
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
