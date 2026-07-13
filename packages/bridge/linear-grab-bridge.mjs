#!/usr/bin/env node
/**
 * Linear Grab bridge — delegate tasks from the browser panel to LOCAL Claude
 * Code sessions running in this repo.
 *
 *   npx linear-grab-bridge [--port 4577] [--dir .] [--claude claude]
 *
 * v0.9: interactive sessions. Each task runs `claude -p` with stream-json
 * INPUT + OUTPUT — the session stays alive after each result, so the panel
 * can send follow-up messages, switch models (applied via --resume respawn),
 * read live token/context usage, and copy a `claude --resume <id>` command.
 * Task history persists to ~/.linear-grab/ across restarts. Zero deps.
 * Binds 127.0.0.1 only — never exposed to the network.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag('--port', '4577'));
const DIR = flag('--dir', process.cwd());
const CLAUDE_BIN = flag('--claude', 'claude');
const VERSION = '0.9.0';
const MAX_TAIL = 300;
const IDLE_KILL_MS = 30 * 60_000; // free an idle interactive session after 30min (resumable)

/** @type {Map<string, any>} */
const tasks = new Map();

// ---- persistence -----------------------------------------------------------

const HISTORY_DIR = join(homedir(), '.linear-grab');
const HISTORY_FILE = join(
  HISTORY_DIR,
  `bridge-${createHash('sha1').update(DIR).digest('hex').slice(0, 10)}.json`,
);

function loadHistory() {
  try {
    const items = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    for (const t of items) {
      tasks.set(t.id, { ...t, child: null, alive: false });
    }
    console.log(`  history: ${items.length} past task(s) loaded`);
  } catch {
    /* first run */
  }
}

let saveTimer = null;
function saveHistory() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(HISTORY_DIR, { recursive: true });
      const items = [...tasks.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 100)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status === 'running' ? 'stopped' : t.status,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          lastText: t.lastText,
          result: t.result,
          sessionId: t.sessionId ?? null,
          model: t.model ?? null,
          usage: t.usage ?? null,
          tail: (t.tail ?? []).slice(-60),
        }));
      writeFileSync(HISTORY_FILE, JSON.stringify(items));
    } catch {
      /* best-effort */
    }
  }, 600);
}

// ---- helpers ---------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-upload-url,x-upload-headers',
};

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
    result: t.status === 'done' ? (t.result?.slice(0, 2000) ?? null) : null,
    sessionId: t.sessionId ?? null,
    model: t.model ?? null,
    pendingModel: t.pendingModel ?? null,
    alive: !!t.alive,
    usage: t.usage ?? null,
    subagents: t.subagents ?? 0,
    permissionMode: t.permissionMode ?? 'acceptEdits',
  };
}

function pushTail(task, kind, text) {
  task.tail.push({ at: Date.now(), kind, text });
  if (task.tail.length > MAX_TAIL) task.tail.shift();
  saveHistory();
}

function userMessageLine(text) {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

// ---- claude process management ---------------------------------------------

function startProcess(task, { resume, initialText }) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    task.permissionMode || 'acceptEdits',
  ];
  if (task.model) args.push('--model', task.model);
  if (resume) args.push('--resume', resume);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(task.env ?? {}) },
  });
  task.child = child;
  task.alive = true;
  task.pendingModel = null;
  if (initialText) {
    child.stdin.write(userMessageLine(initialText));
    task.status = 'running';
  }

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        ingest(task, JSON.parse(line));
      } catch {
        pushTail(task, 'raw', line.slice(0, 500));
      }
    }
  });
  child.stderr.on('data', (chunk) => pushTail(task, 'stderr', String(chunk).slice(0, 500)));
  child.on('error', (err) => {
    task.status = 'error';
    task.alive = false;
    task.endedAt = Date.now();
    task.lastText = `Failed to launch "${CLAUDE_BIN}" — is Claude Code installed and on PATH? (${err.message})`;
    saveHistory();
  });
  child.on('exit', (code) => {
    task.alive = false;
    task.child = null;
    if (task.status === 'running') {
      task.status = code === 0 ? 'done' : 'error';
      if (task.status === 'error') task.lastText = `Exited with code ${code}. ${task.lastText}`;
      task.endedAt = Date.now();
    }
    saveHistory();
  });

  // Free idle sessions eventually — they stay resumable via --resume.
  clearTimeout(task.idleTimer);
  task.idleTimer = setInterval(() => {
    if (task.alive && task.status !== 'running' && Date.now() - (task.lastActivity ?? 0) > IDLE_KILL_MS) {
      try {
        task.child?.stdin.end();
        task.child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      clearInterval(task.idleTimer);
    }
  }, 60_000);
}

function ingest(task, event) {
  task.lastActivity = Date.now();
  if (event.type === 'system' && event.subtype === 'init') {
    task.sessionId = event.session_id ?? task.sessionId;
    if (!task.model && event.model) task.model = event.model;
    saveHistory();
    return;
  }
  if (event.type === 'assistant') {
    const usage = event.message?.usage;
    if (usage) {
      const context =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      task.usage = {
        ...(task.usage ?? { outputTokens: 0, costUsd: 0 }),
        contextTokens: context,
        outputTokens: (task.usage?.outputTokens ?? 0) + (usage.output_tokens ?? 0),
      };
    }
    for (const p of event.message?.content ?? []) {
      if (p.type === 'text' && p.text?.trim()) {
        task.lastText = p.text.trim().slice(0, 300);
        pushTail(task, 'assistant', p.text.trim().slice(0, 2000));
      } else if (p.type === 'tool_use') {
        // Subagent fan-out is worth surfacing distinctly.
        if (p.name === 'Task' || p.name === 'Agent') {
          task.subagents = (task.subagents ?? 0) + 1;
          const label = `⛓ subagent #${task.subagents}: ${String(p.input?.description ?? p.input?.prompt ?? '').slice(0, 140)}`;
          task.lastText = label.slice(0, 300);
          pushTail(task, 'subagent', label.slice(0, 500));
        } else {
          const label = `→ ${p.name}${p.input?.file_path ? ` ${p.input.file_path}` : p.input?.command ? ` ${String(p.input.command).slice(0, 120)}` : ''}`;
          task.lastText = label.slice(0, 300);
          pushTail(task, 'tool', label.slice(0, 500));
        }
      }
    }
    return;
  }
  if (event.type === 'result') {
    task.result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
    task.lastText = (task.result ?? '').slice(0, 300) || task.lastText;
    task.status = event.is_error ? 'error' : 'done';
    task.endedAt = Date.now();
    if (event.usage || event.total_cost_usd != null) {
      task.usage = {
        ...(task.usage ?? {}),
        costUsd: (task.usage?.costUsd ?? 0) + (event.total_cost_usd ?? 0),
      };
    }
    pushTail(task, 'result', (task.result ?? '').slice(0, 2000));
    // Session stays ALIVE for follow-up messages (multi-turn stream-json).
    return;
  }
}

function startTask({ title, prompt, model, env, permissionMode }) {
  const id = randomUUID().slice(0, 8);
  const task = {
    id,
    permissionMode: ['acceptEdits', 'bypassPermissions', 'default', 'plan'].includes(
      String(permissionMode),
    )
      ? String(permissionMode)
      : 'acceptEdits',
    title: String(title ?? 'Task').slice(0, 200),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    lastText: 'Starting Claude Code…',
    tail: [],
    result: null,
    child: null,
    alive: false,
    sessionId: null,
    model: model ? String(model) : null,
    env: env && typeof env === 'object' ? env : null,
    usage: null,
    lastActivity: Date.now(),
  };
  tasks.set(id, task);
  pushTail(task, 'user', String(prompt ?? '').slice(0, 2000));
  startProcess(task, { initialText: String(prompt ?? '') });
  return task;
}

/** Send a follow-up. Respawns via --resume when the process is gone or a model
    change is pending — that's also how model switches take effect. */
function sendMessage(task, text) {
  pushTail(task, 'user', text.slice(0, 2000));
  const needsRespawn = !task.alive || !!task.pendingModel;
  if (needsRespawn) {
    if (task.pendingModel) task.model = task.pendingModel;
    if (task.alive && task.child) {
      try {
        task.child.stdin.end();
        task.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    if (!task.sessionId) throw new Error('No session to resume');
    task.status = 'running';
    task.endedAt = null;
    startProcess(task, { resume: task.sessionId, initialText: text });
  } else {
    task.child.stdin.write(userMessageLine(text));
    task.status = 'running';
    task.endedAt = null;
  }
  saveHistory();
}

// ---- HTTP ------------------------------------------------------------------

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
        ? json(res, 200, { ...summary(t), tail: (t.tail ?? []).slice(-120) })
        : json(res, 404, { error: 'not found' });
    }
    const stop = url.pathname.match(/^\/tasks\/([\w-]+)\/stop$/);
    if (req.method === 'POST' && stop) {
      const t = tasks.get(stop[1]);
      if (t?.child && t.alive) {
        try {
          t.child.stdin.end();
          t.child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        if (t.status === 'running') {
          t.status = 'stopped';
          t.endedAt = Date.now();
          t.lastText = 'Stopped from the panel.';
        }
        saveHistory();
      }
      return json(res, 200, { ok: true });
    }
    const message = url.pathname.match(/^\/tasks\/([\w-]+)\/message$/);
    if (req.method === 'POST' && message) {
      const t = tasks.get(message[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      try {
        sendMessage(t, String(body.text));
        return json(res, 200, summary(t));
      } catch (err) {
        return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const model = url.pathname.match(/^\/tasks\/([\w-]+)\/model$/);
    if (req.method === 'POST' && model) {
      const t = tasks.get(model[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      // Takes effect on the NEXT message (resume respawn) — killing an
      // in-flight turn to switch models would lose work.
      t.pendingModel = body.model ? String(body.model) : null;
      if (!t.alive && t.pendingModel) {
        t.model = t.pendingModel;
        t.pendingModel = null;
      }
      saveHistory();
      return json(res, 200, summary(t));
    }
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: 'prompt required' });
      const task = startTask(body);
      return json(res, 201, summary(task));
    }
    // Upload proxy: browsers can't PUT to Linear's storage (no CORS there) —
    // this local process can. SSRF-guarded to Linear storage hosts.
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
  console.log(`  tasks run: ${CLAUDE_BIN} -p (interactive stream-json, acceptEdits)`);
  loadHistory();
});
