/**
 * Time-sliced DOM → canvas capturer. Functionally like html-to-image's clone
 * pipeline, but cooperatively scheduled: the walk yields to the browser every
 * ~6ms, so capturing even large regions never freezes the page. (The DOM walk
 * itself can't move to a worker — workers have no DOM — so slicing IS the fix.)
 */

const SLICE_MS = 6;

class Slicer {
  private last = performance.now();
  async tick(): Promise<void> {
    if (performance.now() - this.last <= SLICE_MS) return;
    await new Promise<void>((resolve) => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => resolve(), { timeout: 100 });
      } else {
        setTimeout(resolve, 0);
      }
    });
    this.last = performance.now();
  }
}

// ---- UA default styles (per tag), computed in a bare iframe so the page's
// own CSS can't leak in. Built once, reused for every capture. ----
let defaultsDoc: Document | null = null;
const defaultsCache = new Map<string, Record<string, string>>();

function getDefaults(tag: string): Record<string, string> {
  const cached = defaultsCache.get(tag);
  if (cached) return cached;
  if (!defaultsDoc) {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    defaultsDoc = frame.contentDocument;
    if (!defaultsDoc) return {};
  }
  const probe = defaultsDoc.createElement(tag);
  defaultsDoc.body.appendChild(probe);
  const cs = defaultsDoc.defaultView!.getComputedStyle(probe);
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i];
    snapshot[prop] = cs.getPropertyValue(prop);
  }
  probe.remove();
  defaultsCache.set(tag, snapshot);
  return snapshot;
}

/** Warm the defaults iframe + common tags off the hot path (call at init). */
export function prewarmSnapshot(): void {
  try {
    for (const tag of ['div', 'span', 'p', 'a', 'button', 'img', 'ul', 'li', 'svg']) {
      getDefaults(tag);
    }
  } catch {
    /* best-effort */
  }
}

function shouldSkip(el: Element): boolean {
  if (el.id === 'linear-grab-root') return true;
  const tag = el.tagName?.toLowerCase() ?? '';
  return tag === 'overlay-canvas' || tag.startsWith('react-grab') || tag === 'script' || tag === 'iframe';
}

/** Inline an already-decoded <img> as a data URL (SVG-as-image can't fetch). */
function inlineImage(img: HTMLImageElement, clone: HTMLImageElement): void {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width || 1;
    c.height = img.naturalHeight || img.height || 1;
    c.getContext('2d')!.drawImage(img, 0, 0);
    clone.src = c.toDataURL('image/png'); // throws when cross-origin-tainted
  } catch {
    clone.removeAttribute('src');
    clone.setAttribute('style', `${clone.getAttribute('style') ?? ''}background:#8b8e9822;`);
  }
}

async function cloneWithStyles(node: Element, slicer: Slicer): Promise<Element | null> {
  if (shouldSkip(node)) return null;

  // SVG subtrees are attribute-styled — wholesale clone, skip the walk.
  if (node instanceof SVGSVGElement) return node.cloneNode(true) as Element;

  const clone = node.cloneNode(false) as HTMLElement;

  // Inline only the computed props that differ from UA defaults.
  const cs = getComputedStyle(node);
  const defaults = getDefaults(node.tagName.toLowerCase());
  let css = '';
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i];
    const value = cs.getPropertyValue(prop);
    if (value && value !== defaults[prop]) css += `${prop}:${value};`;
  }
  clone.setAttribute('style', css);
  clone.removeAttribute('class'); // page CSS doesn't exist inside the SVG doc

  if (node instanceof HTMLImageElement) inlineImage(node, clone as HTMLImageElement);
  if (node instanceof HTMLCanvasElement) {
    try {
      const img = document.createElement('img');
      img.setAttribute('style', css);
      img.src = node.toDataURL();
      return img;
    } catch {
      /* tainted canvas — keep empty clone */
    }
  }
  if (node instanceof HTMLInputElement) clone.setAttribute('value', node.value);
  if (node instanceof HTMLTextAreaElement) clone.textContent = node.value;

  await slicer.tick();

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      clone.appendChild(child.cloneNode());
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childClone = await cloneWithStyles(child as Element, slicer);
      if (childClone) clone.appendChild(childClone);
    }
  }
  return clone;
}

/**
 * Capture a region without blocking the main thread. Returns a canvas ready
 * for highlight-drawing + worker encoding.
 */
export async function captureRegionSliced(
  container: HTMLElement,
  fontCss: string,
): Promise<HTMLCanvasElement> {
  const rect = container.getBoundingClientRect();
  const w = Math.max(1, Math.ceil(rect.width));
  const h = Math.max(1, Math.ceil(rect.height));

  const slicer = new Slicer();
  const clone = (await cloneWithStyles(container, slicer)) as HTMLElement | null;
  if (!clone) throw new Error('Capture root was filtered');
  clone.style.margin = '0';

  const serialized = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<style>${fontCss}</style>` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">${serialized}</div>` +
    `</foreignObject></svg>`;

  const img = new Image();
  img.decoding = 'async';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode(); // async rasterize — no sync decode on draw

  const scale = Math.min(window.devicePixelRatio || 1, 1.5);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
