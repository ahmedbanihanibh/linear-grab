import { captureRectShot } from './elementShot';
import type { GrabbedElement } from './types';

/** DOM rasterization is hopeless past this many nodes in the region's
    container — huge virtualized editors hang the SVG clone until the 15s
    deadline every time. Above it we go straight to a real tab frame. */
const DOM_RASTER_NODE_BUDGET = 2500;

/** Smallest element fully containing the rect — same walk the DOM path uses. */
function regionContainer(rect: { x: number; y: number; w: number; h: number }): Element {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let container: Element = document.elementFromPoint(cx, cy) ?? document.body;
  const contains = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (
      r.left <= rect.x && r.top <= rect.y && r.right >= rect.x + rect.w && r.bottom >= rect.y + rect.h
    );
  };
  while (container !== document.body && !contains(container)) {
    container = container.parentElement ?? document.body;
  }
  return container;
}

/**
 * Pixel-true fallback: one frame of THIS tab via getDisplayMedia (the same
 * "pick this tab" prompt as Record interaction), cropped to the rect. Works
 * on pages whose DOM is too big to rasterize (canvas editors, huge virtual
 * lists) — exactly where the SVG path times out. Must be called within the
 * pointerup gesture (getDisplayMedia needs transient activation).
 */
async function captureRectViaTabFrame(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<string | null> {
  let stream: MediaStream | null = null;
  const video = document.createElement('video');
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      // Chrome-only hints: offer THIS tab first in the picker.
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    } as MediaStreamConstraints);
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true; // Safari refuses detached playback otherwise
    await video.play();
    // First decoded frame; one extra tick so the share-bar layout settles.
    await new Promise((res) => setTimeout(res, 250));
    const sx = video.videoWidth / window.innerWidth;
    const sy = video.videoHeight / window.innerHeight;
    if (!video.videoWidth || sx <= 0 || sy <= 0) return null;
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(rect.w * sx));
    crop.height = Math.max(1, Math.round(rect.h * sy));
    const ctx = crop.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(
      video,
      rect.x * sx,
      rect.y * sy,
      rect.w * sx,
      rect.h * sy,
      0,
      0,
      crop.width,
      crop.height,
    );
    return crop.toDataURL('image/png');
  } catch (err) {
    console.warn('[linear-grab] tab-frame region capture failed:', err);
    return null;
  } finally {
    video.srcObject = null;
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Interactive region capture: crosshair overlay → drag a rectangle → the
 * selection is rasterized and returned as a GrabbedElement (tagName 'region'),
 * so it flows through the normal capture list / issue attachment pipeline for
 * BOTH executors. Escape or a sub-8px drag cancels.
 */
export function captureRegionInteractive(): Promise<GrabbedElement | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;';
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;display:none;border:2px solid #5e6ad2;border-radius:4px;' +
      'box-shadow:0 0 0 100000px rgba(0,0,0,0.35);pointer-events:none;';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const currentRect = (e: PointerEvent) => ({
      x: Math.min(startX, e.clientX),
      y: Math.min(startY, e.clientY),
      w: Math.abs(e.clientX - startX),
      h: Math.abs(e.clientY - startY),
    });

    const cleanup = () => {
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);

    overlay.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = currentRect(e);
      box.style.display = 'block';
      box.style.left = `${r.x}px`;
      box.style.top = `${r.y}px`;
      box.style.width = `${r.w}px`;
      box.style.height = `${r.h}px`;
    });
    overlay.addEventListener('pointerup', (e) => {
      const r = currentRect(e);
      cleanup(); // remove BEFORE rasterizing so the overlay isn't captured
      if (r.w < 8 || r.h < 8) return resolve(null);
      // Route by page weight: past the node budget the DOM rasterizer times
      // out EVERY time (canvas editors, virtual lists) — go straight to a
      // real tab frame while the pointerup gesture still grants
      // getDisplayMedia its transient activation.
      const nodeCount = regionContainer(r).querySelectorAll('*').length;
      const shotPromise =
        nodeCount > DOM_RASTER_NODE_BUDGET
          ? captureRectViaTabFrame(r)
          : // Hang-proof: a stuck sub-step (font harvest, worker, decode) must
            // still resolve the flow — an unresolved promise stranded the panel.
            Promise.race([
              captureRectShot(r),
              new Promise<string | null>((res) =>
                setTimeout(() => {
                  console.warn('[linear-grab] region capture timed out after 15s');
                  res(null);
                }, 15_000),
              ),
            ]);
      void shotPromise.then((dataUrl) => {
        if (!dataUrl) return resolve(null);
        resolve({
          tagName: 'region',
          componentName: undefined,
          content: `Region capture ${Math.round(r.w)}×${Math.round(r.h)}`,
          source: null,
          stackContext: undefined,
          screenshotDataUrl: dataUrl,
          pageUrl: location.href,
          grabbedAt: Date.now(),
        });
      });
    });
  });
}
