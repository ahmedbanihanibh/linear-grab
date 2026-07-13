/**
 * Lazy singleton client for the image worker. The worker is inlined into the
 * bundle (base64 blob) so the single-file CDN build stays self-contained.
 * Everything degrades gracefully: if the host page's CSP blocks blob workers,
 * callers fall back to their main-thread paths.
 */
import ImageWorker from './imageWorker?worker&inline';

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null | undefined; // undefined = not tried yet
let nextId = 1;
const pending = new Map<number, Pending>();

export function getImageWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new ImageWorker();
    worker.onmessage = (e: MessageEvent<{ id?: number; type: string; message?: string }>) => {
      const id = e.data?.id;
      if (id == null) return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (e.data.type === 'error') p.reject(new Error(e.data.message ?? 'Worker error'));
      else p.resolve(e.data);
    };
    worker.onerror = () => {
      // Kill the session: reject in-flight calls so fallbacks kick in.
      for (const p of pending.values()) p.reject(new Error('Image worker crashed'));
      pending.clear();
    };
  } catch {
    worker = null; // CSP or platform said no — fallbacks take over
  }
  return worker;
}

/** Request/response call. Rejects when no worker is available. */
export function callWorker<T>(
  msg: Record<string, unknown>,
  transfer: Transferable[] = [],
): Promise<T> {
  const w = getImageWorker();
  if (!w) return Promise.reject(new Error('Image worker unavailable'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** Fire-and-forget post (per-frame streaming). Returns false when no worker. */
export function postWorker(msg: Record<string, unknown>, transfer: Transferable[] = []): boolean {
  const w = getImageWorker();
  if (!w) return false;
  w.postMessage(msg, transfer);
  return true;
}
