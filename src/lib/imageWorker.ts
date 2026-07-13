/**
 * Image worker — all heavy pixel work off the main thread:
 *  - PNG/JPEG encoding of element screenshots (OffscreenCanvas.convertToBlob)
 *  - GIF frame quantization + encoding for screen recordings (gifenc)
 *
 * The main thread only does what REQUIRES the DOM: html-to-image's clone and
 * a cheap drawImage/getImageData per recording frame.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

interface BaseMsg {
  id?: number;
  type: string;
}

let gif: ReturnType<typeof GIFEncoder> | null = null;
let gifFirstFrame = true;

self.onmessage = (e: MessageEvent<BaseMsg & Record<string, any>>) => {
  void handle(e.data).catch((err) => {
    if (e.data?.id != null) {
      (self as unknown as Worker).postMessage({
        id: e.data.id,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
};

async function handle(msg: BaseMsg & Record<string, any>): Promise<void> {
  const post = (data: Record<string, unknown>, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id: msg.id, ...data }, transfer);

  switch (msg.type) {
    case 'encode-png': {
      const bitmap = msg.bitmap as ImageBitmap;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2d unavailable');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      let blob = await canvas.convertToBlob({ type: 'image/png' });
      // Keep the data URL sessionStorage-friendly.
      if (blob.size > 1_800_000) {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      }
      post({ type: 'png', dataUrl: await blobToDataUrl(blob) });
      return;
    }
    case 'gif-init': {
      gif = GIFEncoder();
      gifFirstFrame = true;
      post({ type: 'ok' });
      return;
    }
    case 'gif-frame': {
      if (!gif) return;
      const data = new Uint8ClampedArray(msg.buffer as ArrayBuffer);
      const palette = quantize(data, 256, { format: 'rgb565' });
      const index = applyPalette(data, palette, 'rgb565');
      gif.writeFrame(index, msg.width as number, msg.height as number, {
        palette,
        delay: msg.delay as number,
        first: gifFirstFrame,
        repeat: 0,
      });
      gifFirstFrame = false;
      return; // fire-and-forget — no reply per frame
    }
    case 'gif-finish': {
      if (!gif) throw new Error('No active GIF session');
      gif.finish();
      const bytes = gif.bytes();
      gif = null;
      post({ type: 'gif', buffer: bytes.buffer }, [bytes.buffer]);
      return;
    }
    case 'gif-abort': {
      gif = null;
      return;
    }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
