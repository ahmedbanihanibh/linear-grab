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

export async function buildCaptureBlock(): Promise<string | null> {
  const lines: string[] = [];

  for (const g of (await getLastGrab()) ?? []) {
    const loc = g.source?.filePath
      ? ` — \`${g.source.filePath}${g.source.lineNumber != null ? `:${g.source.lineNumber}` : ''}\``
      : '';
    lines.push(`- \`<${g.componentName ?? g.tagName ?? 'element'}>\`${loc}`);
    if (g.screenshotDataUrl) {
      try {
        const url = await withTimeout(
          uploadAsset(dataUrlToBlob(g.screenshotDataUrl), `capture-${g.grabbedAt}.png`),
        );
        lines.push(`  ![capture](${url})`);
      } catch {
        /* screenshot upload blocked — the ref line still lands */
      }
    }
  }

  const rec = getRecorderSnapshot();
  if (rec.result) {
    try {
      const url =
        rec.result.assetUrl ??
        (await withTimeout(uploadAsset(rec.result.blob, `recording-${Date.now()}.gif`)));
      markRecordingUploaded(url);
      lines.push(`![recording](${url})`);
    } catch {
      /* recording upload blocked */
    }
  }

  return lines.length ? `Captured context:\n${lines.join('\n')}` : null;
}
