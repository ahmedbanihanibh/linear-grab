/**
 * Dev-server log tailing. The browser can't read files, so the log must be
 * reachable over HTTP from the dev origin — e.g. tee it into Next's public
 * dir:  "dev:http": "next dev 2>&1 | tee public/dev-server.log"
 * (gitignore the file), then set the Log URL to "/dev-server.log".
 */

const MAX_CHARS = 12_000; // keep the issue body sane
const FETCH_TIMEOUT_MS = 4_000;

export async function fetchDevLogTail(settings: {
  logUrl?: string;
  logLines?: number;
}): Promise<string | null> {
  const url = settings.logUrl?.trim();
  if (!url) return null;
  const n = Math.min(500, Math.max(10, settings.logLines ?? 100));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`Log fetch failed (${res.status})`);
    const text = await res.text();
    let tail = text.split('\n').slice(-n).join('\n').trim();
    if (tail.length > MAX_CHARS) tail = `…\n${tail.slice(tail.length - MAX_CHARS)}`;
    return tail || null;
  } finally {
    clearTimeout(timer);
  }
}
