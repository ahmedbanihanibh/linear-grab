import { captureRectShot } from './elementShot';
import type { GrabbedElement } from './types';

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
      // Hang-proof: a stuck sub-step (font harvest, worker, decode) must
      // still resolve the flow — an unresolved promise stranded the panel.
      const shotPromise = Promise.race([
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
