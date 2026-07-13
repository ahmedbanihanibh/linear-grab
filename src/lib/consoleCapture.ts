/**
 * Console/error ring buffer — the client-side twin of the server-log tail.
 * Hooks console.error/warn + window.onerror + unhandledrejection (originals
 * untouched in behavior), keeps the last 50 entries, and attaches them to
 * issues + AI drafts. In page mode the panel shares the page's JS context,
 * so reading the buffer is a direct call.
 */

export interface ConsoleEntry {
  at: number;
  level: 'error' | 'warn' | 'unhandled';
  text: string;
}

const MAX = 50;
const buffer: ConsoleEntry[] = [];
let installed = false;

function serialize(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg).slice(0, 400);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function push(level: ConsoleEntry['level'], parts: unknown[]): void {
  const text = parts.map(serialize).join(' ').slice(0, 600);
  if (!text.trim()) return;
  buffer.push({ at: Date.now(), level, text });
  if (buffer.length > MAX) buffer.shift();
}

export function installConsoleCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push('error', args);
    origError(...args);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    push('warn', args);
    origWarn(...args);
  };
  window.addEventListener('error', (e) => {
    push('error', [`${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { stack?: string } | undefined;
    push('unhandled', [reason?.stack ?? String(e.reason ?? 'unhandled rejection')]);
  });
}

export function getConsoleTail(n = 30): ConsoleEntry[] {
  return buffer.slice(-n);
}

/** Markdown-ready block, or null when nothing captured. */
export function formatConsoleTail(n = 30): string | null {
  const entries = getConsoleTail(n);
  if (!entries.length) return null;
  const lines = entries.map((e) => {
    const t = new Date(e.at).toTimeString().slice(0, 8);
    return `[${t}] ${e.level.toUpperCase()}: ${e.text}`;
  });
  let out = lines.join('\n');
  if (out.length > 8_000) out = `…\n${out.slice(out.length - 8_000)}`;
  return out;
}
