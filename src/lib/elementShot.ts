import { toCanvas } from 'html-to-image';

/**
 * Screenshot of a picked element for the issue: captures the element's nearest
 * *meaningful container* (not just the element — a lone button crop tells the
 * agent nothing about WHERE it lives) and draws an accent highlight box around
 * the exact target. html-to-image renders via SVG foreignObject, so modern CSS
 * (oklch, container queries) that breaks html2canvas works fine.
 */
export async function captureElementShot(target: Element): Promise<string | null> {
  try {
    const container = pickContainer(target);
    const canvas = await toCanvas(container as HTMLElement, {
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      filter: (node: HTMLElement) => {
        if (!(node instanceof Element)) return true;
        // Never capture our own panel or react-grab's overlay chrome.
        if (node.id === 'linear-grab-root') return false;
        const tag = node.tagName?.toLowerCase() ?? '';
        if (tag === 'overlay-canvas' || tag.startsWith('react-grab')) return false;
        return true;
      },
    });
    drawHighlight(canvas, container, target);
    return canvasToDataUrl(canvas);
  } catch {
    return null; // Screenshot is best-effort — never block the grab itself.
  }
}

/**
 * Climb ancestors until the region is big enough to give location context
 * (≥55% viewport width, ≥35% height), but never balloon past ~1.7× the
 * viewport area (full-page captures are slow and unhelpful).
 */
function pickContainer(target: Element): Element {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxArea = vw * vh * 1.7;

  let best: Element = target;
  let node: Element | null = target;
  while (node && node !== document.body && node !== document.documentElement) {
    const r = node.getBoundingClientRect();
    if (r.width * r.height > maxArea) break;
    best = node;
    if (r.width >= vw * 0.55 && r.height >= vh * 0.35) break;
    node = node.parentElement;
  }
  return best;
}

function drawHighlight(canvas: HTMLCanvasElement, container: Element, target: Element): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cRect = container.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  if (!cRect.width || !cRect.height) return;

  const sx = canvas.width / cRect.width;
  const sy = canvas.height / cRect.height;
  const x = (tRect.left - cRect.left) * sx;
  const y = (tRect.top - cRect.top) * sy;
  const w = tRect.width * sx;
  const h = tRect.height * sy;
  const r = Math.min(6 * sx, w / 2, h / 2);

  // Soft outer glow, then a crisp accent stroke — matches the picker overlay.
  ctx.strokeStyle = 'rgba(94, 106, 210, 0.35)';
  ctx.lineWidth = 8 * sx;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();

  ctx.strokeStyle = '#5e6ad2';
  ctx.lineWidth = 3 * sx;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();
}

/** PNG by default; fall back to JPEG when the data URL would blow past ~2.5MB
    (it has to fit in sessionStorage alongside everything else). */
function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  const png = canvas.toDataURL('image/png');
  if (png.length <= 2_500_000) return png;
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Decode a data URL back into a Blob for upload. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, base64] = dataUrl.split(',');
  const mime = meta.match(/data:([^;]+)/)?.[1] ?? 'image/png';
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}
