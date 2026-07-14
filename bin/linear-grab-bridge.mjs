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
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const VERSION = '0.23.0';

/** Best-effort command runner (git/gh introspection). Never throws. */
function run(cmd, args, cwd = DIR) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 15_000, maxBuffer: 2_000_000 }, (err, stdout) =>
      resolve(err ? null : stdout.toString()),
    );
  });
}

/** Opt-in isolation: give a task its own git worktree + branch so parallel
    local agents never trample each other's working tree. */
async function setupWorktree(task) {
  const base = join(
    HISTORY_DIR,
    'worktrees',
    createHash('sha1').update(DIR).digest('hex').slice(0, 8),
  );
  mkdirSync(base, { recursive: true });
  const path = join(base, task.id);
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const branch = `lg/${slug || 'task'}-${task.id}`;
  const out = await run('git', ['worktree', 'add', path, '-b', branch]);
  if (out === null) return null;
  return { path, branch, removed: false };
}
const MAX_TAIL = 300;
const IDLE_KILL_MS = 30 * 60_000; // free an idle interactive session after 30min (resumable)

/** @type {Map<string, any>} */
const tasks = new Map();

/** Linear Authorization header supplied by the panel (for the media proxy). */
let linearAuth = null;

/** PR state cache (gh pr view) — 60s TTL. */
const prStatusCache = new Map();

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
          startCommit: t.startCommit ?? null,
          subagents: t.subagents ?? 0,
          worktree: t.worktree ?? null,
          cwd: t.cwd ?? null,
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
    worktree: t.worktree ?? null,
    lastEventAt: t.tail?.length ? t.tail[t.tail.length - 1].at : (t.startedAt ?? null),
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
    cwd: task.cwd ?? DIR,
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
    // The stream tells us the ACTUAL model — surface it even for defaults.
    if (event.message?.model) task.model = event.message.model;
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

async function startTask({ title, prompt, model, env, permissionMode, worktree }) {
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
  if (worktree) {
    const wt = await setupWorktree(task);
    if (wt) {
      task.worktree = wt;
      task.cwd = wt.path;
      pushTail(task, 'tool', `⎇ isolated worktree: ${wt.branch} @ ${wt.path}`);
    } else {
      pushTail(task, 'stderr', 'Worktree setup failed — running in the main working tree.');
    }
  }
  // Snapshot HEAD so the Changes view can attribute work to this task.
  task.startCommit = ((await run('git', ['rev-parse', 'HEAD'], task.cwd ?? DIR)) ?? '').trim() || null;
  startProcess(task, { initialText: String(prompt ?? '') });
  return task;
}

/** What this task changed: files (+/−), branch, untracked, matching PRs. */
async function computeDiff(task) {
  const cwd = task.cwd ?? DIR;
  const branch = (await run('git', ['branch', '--show-current'], cwd))?.trim() ?? '';
  const base = task.startCommit;
  const numstat = (await run('git', ['diff', '--numstat', ...(base ? [base] : [])], cwd)) ?? '';
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...path] = line.split('\t');
      return {
        path: path.join('\t'),
        added: a === '-' ? 0 : Number(a),
        deleted: d === '-' ? 0 : Number(d),
        binary: a === '-',
      };
    })
    .filter((f) => f.path);
  const untracked = ((await run('git', ['status', '--porcelain'], cwd)) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .slice(0, 40);

  // PRs: by current head branch AND by the issue identifier in the title.
  const prs = new Map();
  const ident = task.title.match(/^([A-Z][A-Z0-9]*-\d+)/)?.[1];
  for (const args of [
    branch ? ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,title,state', '--limit', '3'] : null,
    ident ? ['pr', 'list', '--search', ident, '--state', 'all', '--json', 'url,title,state', '--limit', '3'] : null,
  ]) {
    if (!args) continue;
    try {
      const out = await run('gh', args, cwd);
      for (const pr of JSON.parse(out ?? '[]')) prs.set(pr.url, pr);
    } catch {
      /* gh missing or not a repo with remote */
    }
  }

  return {
    branch,
    baseCommit: base ?? null,
    files: files.slice(0, 60),
    untracked,
    totalAdded: files.reduce((n, f) => n + f.added, 0),
    totalDeleted: files.reduce((n, f) => n + f.deleted, 0),
    prs: [...prs.values()],
  };
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
      // Committed project config — read fresh each poll so edits apply live.
      let projectConfig = null;
      try {
        projectConfig = JSON.parse(readFileSync(join(DIR, '.lineargrab.json'), 'utf8'));
      } catch {
        /* missing or invalid — fine */
      }
      return json(res, 200, {
        ok: true,
        version: VERSION,
        cwd: DIR,
        active: [...tasks.values()].filter((t) => t.status === 'running').length,
        projectConfig,
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
    const diff = url.pathname.match(/^\/tasks\/([\w-]+)\/diff$/);
    if (req.method === 'GET' && diff) {
      const t = tasks.get(diff[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      return json(res, 200, await computeDiff(t));
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
    const wtRemove = url.pathname.match(/^\/tasks\/([\w-]+)\/worktree\/remove$/);
    if (req.method === 'POST' && wtRemove) {
      const t = tasks.get(wtRemove[1]);
      if (!t?.worktree || t.worktree.removed) return json(res, 404, { error: 'no worktree' });
      if (t.status === 'running') return json(res, 409, { error: 'task still running' });
      await run('git', ['worktree', 'remove', '--force', t.worktree.path]);
      t.worktree.removed = true;
      t.cwd = null;
      saveHistory();
      return json(res, 200, summary(t));
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
      const task = await startTask(body);
      return json(res, 201, summary(task));
    }
    // Panel hands us its Linear auth so /fetch can display Linear-hosted media.
    if (req.method === 'POST' && url.pathname === '/config') {
      const body = await readBody(req);
      if (typeof body.linearAuth === 'string') linearAuth = body.linearAuth;
      return json(res, 200, { ok: true });
    }
    // Media proxy: uploads.linear.app requires Linear auth on every GET — an
    // <img>/<video> tag can't send headers, this local process can.
    if (req.method === 'GET' && url.pathname === '/fetch') {
      const target = url.searchParams.get('url') ?? '';
      let host = '';
      try {
        host = new URL(target).hostname;
      } catch {
        /* invalid */
      }
      if (!/(^|\.)uploads\.linear\.app$/.test(host)) {
        return json(res, 400, { error: 'host not allowed' });
      }
      const upstream = await fetch(target, {
        headers: linearAuth ? { Authorization: linearAuth } : {},
      });
      if (!upstream.ok) return json(res, upstream.status, { error: `upstream ${upstream.status}` });
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
        ...CORS,
      });
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }
    // Real PR states (OPEN/MERGED/CLOSED) via gh — the panel can't know
    // merge status from Linear attachments alone.
    if (req.method === 'POST' && url.pathname === '/pr/status') {
      const body = await readBody(req);
      const urls = (Array.isArray(body.urls) ? body.urls : []).slice(0, 20);
      const statuses = {};
      const previews = {};
      await Promise.all(
        urls.map(async (u) => {
          const prUrl = String(u);
          if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(prUrl)) return;
          const cached = prStatusCache.get(prUrl);
          if (cached && Date.now() - cached.at < 60_000) {
            statuses[prUrl] = cached.state;
            if (cached.preview) previews[prUrl] = cached.preview;
            return;
          }
          // comments carry the Vercel bot's preview link; statusCheckRollup
          // has it too but comments survive check re-runs.
          const out = await run('gh', ['pr', 'view', prUrl, '--json', 'state,comments,body']);
          try {
            const parsed = JSON.parse(out ?? '');
            const state = parsed.state;
            const haystack =
              (parsed.comments ?? []).map((c) => c.body ?? '').join('\n') + '\n' + (parsed.body ?? '');
            const preview = (haystack.match(/https:\/\/[a-z0-9-]+\.vercel\.app[^\s)"\]]*/i) ?? [])[0] ?? null;
            if (state) {
              prStatusCache.set(prUrl, { state, preview, at: Date.now() });
              statuses[prUrl] = state;
              if (preview) previews[prUrl] = preview;
            }
          } catch {
            /* gh missing / not accessible */
          }
        }),
      );
      return json(res, 200, { statuses, previews });
    }
    // ---- react-scan telemetry -------------------------------------------
    // Browser pushes render/interaction events; they land in an append-only
    // NDJSON file agents read directly (.lineargrab/scan.ndjson at the repo).
    if (req.method === 'POST' && url.pathname === '/scan/events') {
      const body = await readBody(req);
      const events = Array.isArray(body.events) ? body.events : [body];
      const dir = join(DIR, '.lineargrab');
      try {
        mkdirSync(dir, { recursive: true });
        // Self-ignoring: telemetry must never pollute commits.
        writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
      } catch {
        /* exists */
      }
      const file = join(dir, 'scan.ndjson');
      const lines =
        events
          .slice(0, 200)
          .map((e) => JSON.stringify({ at: Date.now(), ...e }))
          .join('\n') + '\n';
      try {
        appendFileSync(file, lines);
        // Rotation: cap ~2MB by keeping the newest half.
        const size = statSync(file).size;
        if (size > 2_000_000) {
          const keep = readFileSync(file, 'utf8');
          writeFileSync(file, keep.slice(Math.floor(keep.length / 2)).replace(/^[^\n]*\n/, ''));
        }
      } catch {
        /* disk issues — telemetry must never error the page */
      }
      return json(res, 200, { ok: true });
    }
    // Aggregated "what's slow right now" — a convenience view over the file.
    if (req.method === 'GET' && url.pathname === '/scan/report') {
      const windowMs = Number(url.searchParams.get('window') ?? 120_000);
      let raw = '';
      try {
        raw = readFileSync(join(DIR, '.lineargrab', 'scan.ndjson'), 'utf8');
      } catch {
        return json(res, 200, { report: 'No scan telemetry yet — is react-scan running with the bridge enabled?', components: [] });
      }
      const cutoff = Date.now() - windowMs;
      const byComponent = new Map();
      const interactions = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if ((e.at ?? 0) < cutoff) continue;
        if (e.kind === 'interaction') interactions.push(e);
        for (const c of e.components ?? []) {
          const cur = byComponent.get(c.name) ?? {
            name: c.name,
            renders: 0,
            selfTime: 0,
            source: c.source ?? null,
            unnecessary: 0,
            changes: {},
          };
          cur.renders += c.renders ?? 1;
          cur.selfTime += c.selfTime ?? 0;
          if (c.source) cur.source = c.source;
          if (c.unnecessary) cur.unnecessary += c.renders ?? 1;
          for (const ch of c.changes ?? []) cur.changes[ch] = (cur.changes[ch] ?? 0) + 1;
          byComponent.set(c.name, cur);
        }
      }
      const components = [...byComponent.values()].sort((a, b) => b.selfTime - a.selfTime).slice(0, 25);
      const md = [
        `# react-scan report (last ${Math.round(windowMs / 1000)}s)`,
        '',
        ...components.map(
          (c) =>
            `- **${c.name}** — ${c.renders} renders · ${c.selfTime.toFixed(1)}ms self` +
            (c.unnecessary ? ` · ${c.unnecessary} unnecessary` : '') +
            (c.source ? ` · \`${c.source}\`` : '') +
            (Object.keys(c.changes).length
              ? ` · causes: ${Object.entries(c.changes)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([k, v]) => `${k}×${v}`)
                  .join(', ')}`
              : ''),
        ),
        '',
        ...interactions
          .slice(-10)
          .map(
            (i) =>
              `- interaction ${i.type ?? '?'} on ${i.target ?? '?'} — ${Math.round(i.duration ?? 0)}ms` +
              (i.slow ? ' ⚠ SLOW' : ''),
          ),
      ].join('\n');
      return json(res, 200, { report: md, components, interactions: interactions.slice(-20) });
    }
    // Reset the staging branch: delete + recreate from the default branch.
    if (req.method === 'POST' && url.pathname === '/branch/reset') {
      const body = await readBody(req);
      const prUrl = String(body.url ?? '');
      const base = String(body.base || 'staging').replace(/[^\w./-]/g, '');
      const m = prUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+$/);
      if (!m) return json(res, 400, { error: 'invalid PR url' });
      const repo = `${m[1]}/${m[2]}`;
      await run('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${base}`]);
      const def = ((await run('gh', ['api', `repos/${repo}`, '-q', '.default_branch'])) ?? 'main').trim();
      const sha = ((await run('gh', ['api', `repos/${repo}/git/ref/heads/${def}`, '-q', '.object.sha'])) ?? '').trim();
      if (!sha) return json(res, 500, { error: `could not read ${def}` });
      const created = await run('gh', ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${base}`, '-f', `sha=${sha}`]);
      if (created == null) return json(res, 500, { error: `could not recreate ${base}` });
      return json(res, 200, { ok: true, base, from: def });
    }
    // Vercel build logs for a deployment URL — the panel's terminal card.
    if (req.method === 'POST' && url.pathname === '/deploy/logs') {
      const body = await readBody(req);
      const deployUrl = String(body.deployUrl ?? '');
      if (!/^https:\/\/[\w.-]+\.vercel\.app/.test(deployUrl))
        return json(res, 400, { error: 'invalid deployment url' });
      const out = await new Promise((resolve) => {
        execFile(
          'vercel',
          ['inspect', deployUrl, '--logs'],
          { timeout: 30_000, maxBuffer: 4_000_000 },
          (err, stdout, stderr) => resolve(stdout || stderr || (err ? String(err.message) : '')),
        );
      });
      return json(res, 200, { logs: String(out).split('\n').slice(-400).join('\n') });
    }
    // Live status of the staging deploy: Vercel mirrors every branch deploy
    // into GitHub Deployments (state + environment_url) — pollable via gh.
    if (req.method === 'POST' && url.pathname === '/branch/status') {
      const body = await readBody(req);
      const prUrl = String(body.url ?? '');
      const base = String(body.base || 'staging').replace(/[^\w./-]/g, '');
      const m = prUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+$/);
      if (!m) return json(res, 400, { error: 'invalid PR url' });
      const repo = `${m[1]}/${m[2]}`;
      try {
        const deps = JSON.parse(
          (await run('gh', ['api', `repos/${repo}/deployments?ref=${base}&per_page=1`])) ?? '[]',
        );
        if (!deps.length) {
          // Not every Vercel project populates GitHub Deployments — the commit
          // status ('vercel' context) is the reliable fallback.
          const combined = JSON.parse(
            (await run('gh', ['api', `repos/${repo}/commits/${base}/status`])) ?? '{}',
          );
          const st = (combined.statuses ?? []).find((x) => /vercel/i.test(x.context ?? '')) ?? null;
          const map = { success: 'success', pending: 'in_progress', failure: 'failure', error: 'error' };
          return json(res, 200, {
            state: st ? (map[st.state] ?? st.state) : 'none',
            url: st?.target_url ?? null,
            at: st?.updated_at ?? null,
            sha: (combined.sha ?? '').slice(0, 7),
          });
        }
        const statuses = JSON.parse(
          (await run('gh', ['api', `repos/${repo}/deployments/${deps[0].id}/statuses?per_page=1`])) ?? '[]',
        );
        const st = statuses[0] ?? null;
        return json(res, 200, {
          state: st?.state ?? 'pending', // pending | in_progress | success | failure | error
          url: st?.environment_url ?? null,
          at: st?.updated_at ?? deps[0].created_at,
          sha: (deps[0].sha ?? '').slice(0, 7),
        });
      } catch {
        return json(res, 200, { state: 'unknown' });
      }
    }
    // Merge a PR's branch into a staging branch (creating it from the default
    // branch if missing) — Vercel then deploys it to the staging domain.
    if (req.method === 'POST' && url.pathname === '/pr/stage') {
      const body = await readBody(req);
      const prUrl = String(body.url ?? '');
      const base = String(body.base || 'staging').replace(/[^\w./-]/g, '');
      const m = prUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+$/);
      if (!m) return json(res, 400, { error: 'invalid PR url' });
      const repo = `${m[1]}/${m[2]}`;
      let head = null;
      try {
        head = JSON.parse((await run('gh', ['pr', 'view', prUrl, '--json', 'headRefName'])) ?? '').headRefName;
      } catch {
        /* fallthrough */
      }
      if (!head) return json(res, 500, { error: 'could not resolve the PR head branch (is gh authenticated?)' });
      const baseExists = await run('gh', ['api', `repos/${repo}/branches/${base}`]);
      if (baseExists == null) {
        const def = ((await run('gh', ['api', `repos/${repo}`, '-q', '.default_branch'])) ?? 'main').trim();
        const sha = ((await run('gh', ['api', `repos/${repo}/git/ref/heads/${def}`, '-q', '.object.sha'])) ?? '').trim();
        if (!sha) return json(res, 500, { error: `staging branch missing and could not read ${def}` });
        const created = await run('gh', ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${base}`, '-f', `sha=${sha}`]);
        if (created == null) return json(res, 500, { error: `could not create branch ${base}` });
      }
      const out = await run('gh', ['api', '-X', 'POST', `repos/${repo}/merges`, '-f', `base=${base}`, '-f', `head=${head}`]);
      if (out == null)
        return json(res, 409, { error: `merge of ${head} into ${base} failed — likely a conflict; resolve manually` });
      return json(res, 200, { ok: true, base, head });
    }
    // Fast-merge: after reviewing the demo, one click merges the PR via gh.
    if (req.method === 'POST' && url.pathname === '/pr/merge') {
      const body = await readBody(req);
      const prUrl = String(body.url ?? '');
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(prUrl)) {
        return json(res, 400, { error: 'invalid PR url' });
      }
      const out = await run('gh', ['pr', 'merge', prUrl, '--squash']);
      prStatusCache.delete(prUrl);
      if (out === null) {
        return json(res, 502, { error: 'gh pr merge failed — check gh auth / merge conflicts / required checks' });
      }
      return json(res, 200, { ok: true, output: out.slice(0, 500) });
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
