#!/usr/bin/env node
/**
 * Linear Grab bridge — delegate tasks from the browser panel to LOCAL Claude
 * Code sessions running in this repo.
 *
 *   npx linear-grab-bridge [--port 4577] [--dir .] [--claude claude]
 *
 * Each task spawns a headless `claude -p` session (stream-json output) in the
 * repo directory. The browser polls task status over localhost. Zero deps.
 * Binds 127.0.0.1 only — never exposed to the network.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag('--port', '4577'));
const DIR = flag('--dir', process.cwd());
const CLAUDE_BIN = flag('--claude', 'claude');
const VERSION = '0.8.0';
const MAX_TAIL = 200;

/** @type {Map<string, any>} */
const tasks = new Map();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-upload-url,x-upload-headers',
};

/** Upload proxy targets — Linear's storage only (SSRF guard). */
const UPLOAD_HOSTS = /(^|\.)uploads\.linear\.app$|(^|\.)storage\.googleapis\.com$/;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function summary(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? null,
    lastText: t.lastText,
    result: t.status === 'done' ? t.result?.slice(0, 2000) ?? null : null,
  };
}

function startTask({ title, prompt }) {
  const id = randomUUID().slice(0, 8);
  const task = {
    id,
    title: String(title ?? 'Task').slice(0, 200),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    lastText: 'Starting Claude Code…',
    tail: [],
    result: null,
    child: null,
  };
  tasks.set(id, task);

  // Headless Claude Code: prompt over stdin (avoids argv limits), streamed
  // JSON events out. acceptEdits lets it actually work unattended; pass extra
  // flags via --claude-args if you need a different permission posture.
  const child = spawn(
    CLAUDE_BIN,
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'],
    { cwd: DIR, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  task.child = child;
  child.stdin.write(String(prompt ?? ''));
  child.stdin.end();

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        ingest(task, event);
      } catch {
        pushTail(task, line.slice(0, 500));
      }
    }
  });
  child.stderr.on('data', (chunk) => pushTail(task, `[stderr] ${String(chunk).slice(0, 500)}`));
  child.on('error', (err) => {
    task.status = 'error';
    task.endedAt = Date.now();
    task.lastText = `Failed to launch "${CLAUDE_BIN}" — is Claude Code installed and on PATH? (${err.message})`;
  });
  child.on('exit', (code) => {
    if (task.status === 'running') {
      task.status = code === 0 ? 'done' : 'error';
      if (task.status === 'error') task.lastText = `Exited with code ${code}. ${task.lastText}`;
    }
    task.endedAt = Date.now();
    task.child = null;
  });
  return task;
}

function pushTail(task, text) {
  task.tail.push({ at: Date.now(), text });
  if (task.tail.length > MAX_TAIL) task.tail.shift();
}

function ingest(task, event) {
  // stream-json events: system/init, assistant messages, tool use, final result.
  if (event.type === 'assistant') {
    const parts = event.message?.content ?? [];
    for (const p of parts) {
      if (p.type === 'text' && p.text?.trim()) {
        task.lastText = p.text.trim().slice(0, 300);
        pushTail(task, task.lastText);
      } else if (p.type === 'tool_use') {
        const label = `→ ${p.name}${p.input?.file_path ? ` ${p.input.file_path}` : ''}`;
        task.lastText = label.slice(0, 300);
        pushTail(task, label.slice(0, 500));
      }
    }
  } else if (event.type === 'result') {
    task.result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
    task.lastText = (task.result ?? '').slice(0, 300) || task.lastText;
    task.status = event.is_error ? 'error' : 'done';
    task.endedAt = Date.now();
    pushTail(task, `[result] ${(task.result ?? '').slice(0, 1000)}`);
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        cwd: DIR,
        active: [...tasks.values()].filter((t) => t.status === 'running').length,
      });
    }
    if (req.method === 'GET' && url.pathname === '/tasks') {
      const list = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map(summary);
      return json(res, 200, { tasks: list });
    }
    const detail = url.pathname.match(/^\/tasks\/([\w-]+)$/);
    if (req.method === 'GET' && detail) {
      const t = tasks.get(detail[1]);
      return t
        ? json(res, 200, { ...summary(t), tail: t.tail.slice(-60) })
        : json(res, 404, { error: 'not found' });
    }
    const stop = url.pathname.match(/^\/tasks\/([\w-]+)\/stop$/);
    if (req.method === 'POST' && stop) {
      const t = tasks.get(stop[1]);
      if (t?.child && t.status === 'running') {
        t.child.kill('SIGTERM');
        t.status = 'stopped';
        t.endedAt = Date.now();
        t.lastText = 'Stopped from the panel.';
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: 'prompt required' });
      const task = startTask(body);
      return json(res, 201, summary(task));
    }
    // Upload proxy: browsers can't PUT to Linear's storage (its endpoint has
    // no CORS support) — this local process can. Panel sends the signed URL +
    // headers it got from the fileUpload mutation; we relay the bytes.
    if (req.method === 'POST' && url.pathname === '/put') {
      const target = String(req.headers['x-upload-url'] ?? '');
      let host = '';
      try {
        host = new URL(target).hostname;
      } catch {
        /* invalid */
      }
      if (!UPLOAD_HOSTS.test(host)) return json(res, 400, { error: 'target host not allowed' });
      const extra = JSON.parse(String(req.headers['x-upload-headers'] ?? '{}'));
      const chunks = [];
      for await (const c of req) {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 30_000_000) {
          return json(res, 413, { error: 'file too large' });
        }
      }
      const upstream = await fetch(target, {
        method: 'PUT',
        headers: {
          'Content-Type': String(req.headers['content-type'] ?? 'application/octet-stream'),
          ...extra,
        },
        body: Buffer.concat(chunks),
      });
      return json(res, upstream.ok ? 200 : 502, { ok: upstream.ok, status: upstream.status });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`linear-grab bridge v${VERSION}`);
  console.log(`  repo:   ${DIR}`);
  console.log(`  listen: http://127.0.0.1:${PORT}  (localhost only)`);
  console.log(`  tasks run: ${CLAUDE_BIN} -p --permission-mode acceptEdits`);
});
