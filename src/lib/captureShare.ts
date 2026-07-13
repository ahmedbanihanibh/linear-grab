import { getLastGrab } from './storage';
import { getRecorderSnapshot, markRecordingUploaded } from './recorder';
import { uploadAsset } from './assetUpload';
import { dataUrlToBlob } from './elementShot';

/**
 * One markdown block carrying EVERYTHING captured — element source refs,
 * their screenshots, region captures, and the recording GIF — attachable to
 * any follow-up: Activity replies, Local agent messages, wherever. Uploads
 * go through the full asset chain (Linear → bridge relay → GitHub fallback).
 */
function withTimeout<T>(promise: Promise<T>, ms = 6_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('upload timeout')), ms)),
  ]);
}

export interface CaptureBlockResult {
  block: string | null;
  /** Human-readable upload failures — surface these, never swallow them. */
  failed: string[];
}

export async function buildCaptureBlock(): Promise<CaptureBlockResult> {
  const lines: string[] = [];
  const failed: string[] = [];

  for (const g of (await getLastGrab()) ?? []) {
    const loc = g.source?.filePath
      ? ` — \`${g.source.filePath}${g.source.lineNumber != null ? `:${g.source.lineNumber}` : ''}\``
      : '';
    lines.push(`- \`<${g.componentName ?? g.tagName ?? 'element'}>\`${loc}`);
    if (g.screenshotDataUrl) {
      try {
        const url = await withTimeout(
          uploadAsset(dataUrlToBlob(g.screenshotDataUrl), `capture-${g.grabbedAt}.png`),
          15_000,
        );
        lines.push(`  ![capture](${url})`);
      } catch {
        failed.push('element screenshot upload failed — the ref line still landed');
      }
    }
  }

  const rec = getRecorderSnapshot();
  if (rec.result) {
    try {
      // GIFs are multi-MB — a short timeout silently dropped every recording.
      const url =
        rec.result.assetUrl ??
        (await withTimeout(uploadAsset(rec.result.blob, `recording-${Date.now()}.gif`), 60_000));
      markRecordingUploaded(url);
      lines.push(`![recording](${url})`);
    } catch (err) {
      failed.push(
        `recording upload failed (${err instanceof Error ? err.message : 'error'}) — Copy GIF from the Capture tab and paste it instead`,
      );
    }
  }

  return { block: lines.length ? `Captured context:\n${lines.join('\n')}` : null, failed };
}
