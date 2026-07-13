import { GIFEncoder, quantize, applyPalette } from 'gifenc';

/**
 * Screen-interaction recorder → animated GIF.
 *
 * Module-level singleton, deliberately outside any component: in page mode the
 * panel unmounts while closed, and users will often close it to record the app
 * cleanly — the recording must survive that.
 *
 * Frames are quantized + written into the GIF encoder LIVE during capture
 * (~15–25ms per frame at 6fps), so memory stays flat instead of buffering raw
 * RGBA frames (which would be hundreds of MB for a 30s capture).
 *
 * GIF (not WebP/MP4) because Linear renders GIFs inline in issues/comments and
 * coding agents can read them as images — the whole point is the agent seeing
 * the interaction.
 */

export type RecorderPhase = 'idle' | 'recording' | 'processing' | 'ready' | 'error';

export interface RecordingResult {
  blob: Blob;
  /** Object URL for previewing in an <img>. Revoked on discard. */
  url: string;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  /** Set after the first successful Linear upload so we never upload twice. */
  assetUrl?: string;
}

export interface RecorderSnapshot {
  phase: RecorderPhase;
  startedAt: number | null;
  result: RecordingResult | null;
  error: string | null;
}

const FPS = 6;
const FRAME_DELAY_MS = Math.round(1000 / FPS);
const MAX_DURATION_MS = 30_000;
const MAX_WIDTH = 640;

let snapshot: RecorderSnapshot = { phase: 'idle', startedAt: null, result: null, error: null };
const listeners = new Set<(s: RecorderSnapshot) => void>();

function setSnapshot(patch: Partial<RecorderSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const cb of listeners) cb(snapshot);
}

export function getRecorderSnapshot(): RecorderSnapshot {
  return snapshot;
}

export function subscribeRecorder(cb: (s: RecorderSnapshot) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- capture internals ----

let stream: MediaStream | null = null;
let videoEl: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let encoder: ReturnType<typeof GIFEncoder> | null = null;
let frameCount = 0;
let firstFrame = true;

export async function startRecording(): Promise<void> {
  if (snapshot.phase === 'recording' || snapshot.phase === 'processing') return;
  discardRecording();

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: FPS },
      audio: false,
      // Chrome offers "this tab" first; Safari/Firefox show their own pickers.
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
  } catch {
    setSnapshot({ phase: 'error', error: 'Screen capture was denied or cancelled.' });
    return;
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    setSnapshot({ phase: 'error', error: 'No video track available.' });
    cleanupCapture();
    return;
  }
  // User hit the browser's own "Stop sharing" UI.
  track.addEventListener('ended', () => void stopRecording());

  videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {});

  // Wait for real dimensions (Safari can report 0x0 immediately after play()).
  const deadline = Date.now() + 3000;
  while (!videoEl.videoWidth && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!videoEl.videoWidth) {
    setSnapshot({ phase: 'error', error: 'Could not read the capture stream.' });
    cleanupCapture();
    return;
  }

  const scale = Math.min(1, MAX_WIDTH / videoEl.videoWidth);
  const width = Math.round(videoEl.videoWidth * scale);
  const height = Math.round(videoEl.videoHeight * scale);

  canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    setSnapshot({ phase: 'error', error: 'Canvas is unavailable.' });
    cleanupCapture();
    return;
  }

  encoder = GIFEncoder();
  frameCount = 0;
  firstFrame = true;
  setSnapshot({ phase: 'recording', startedAt: Date.now(), error: null, result: null });

  tickTimer = setInterval(() => {
    if (!ctx || !videoEl || !encoder || !canvas) return;
    const started = snapshot.startedAt ?? Date.now();
    if (Date.now() - started >= MAX_DURATION_MS) {
      void stopRecording();
      return;
    }
    try {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // rgb565: fastest quantization path, plenty for UI captures.
      const palette = quantize(data, 256, { format: 'rgb565' });
      const index = applyPalette(data, palette, 'rgb565');
      encoder.writeFrame(index, canvas.width, canvas.height, {
        palette,
        delay: FRAME_DELAY_MS,
        first: firstFrame,
        repeat: 0, // loop forever
      });
      firstFrame = false;
      frameCount++;
    } catch {
      // Skip a bad frame rather than killing the recording.
    }
  }, FRAME_DELAY_MS);
}

export async function stopRecording(): Promise<void> {
  if (snapshot.phase !== 'recording') return;
  const startedAt = snapshot.startedAt ?? Date.now();
  setSnapshot({ phase: 'processing' });

  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  const width = canvas?.width ?? 0;
  const height = canvas?.height ?? 0;
  const frames = frameCount;
  const enc = encoder;
  encoder = null;
  cleanupCapture();

  if (!enc || frames === 0) {
    setSnapshot({ phase: 'error', error: 'Nothing was captured.' });
    return;
  }

  try {
    enc.finish();
    const bytes = enc.bytes();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
    const result: RecordingResult = {
      blob,
      url: URL.createObjectURL(blob),
      width,
      height,
      frameCount: frames,
      durationMs: Date.now() - startedAt,
    };
    setSnapshot({ phase: 'ready', result });
  } catch (err) {
    setSnapshot({
      phase: 'error',
      error: err instanceof Error ? err.message : 'GIF encoding failed.',
    });
  }
}

export function discardRecording(): void {
  if (snapshot.result?.url) URL.revokeObjectURL(snapshot.result.url);
  cleanupCapture();
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  encoder = null;
  frameCount = 0;
  setSnapshot({ phase: 'idle', startedAt: null, result: null, error: null });
}

/** Remember the Linear asset URL after upload so attach + copy reuse it. */
export function markRecordingUploaded(assetUrl: string): void {
  if (snapshot.result) {
    setSnapshot({ result: { ...snapshot.result, assetUrl } });
  }
}

function cleanupCapture(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (videoEl) {
    videoEl.srcObject = null;
    videoEl = null;
  }
  canvas = null;
  ctx = null;
}
