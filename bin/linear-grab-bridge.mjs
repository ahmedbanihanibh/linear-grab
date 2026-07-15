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
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag('--port', '4577'));
const DIR = flag('--dir', process.cwd());
const CLAUDE_BIN = flag('--claude', 'claude');
const VERSION = '0.25.1';

// ---- audit subcommand dispatch ---------------------------------------------
// `npx linear-grab-bridge audit` is a headless design gate — it sweeps a
// running dev app route-by-route in Chromium (driven over raw CDP), runs the
// slop-scan design-contract scan, writes a report, and exits nonzero when new
// violations exceed the baseline. It must NEVER start the HTTP server below.
// Guarded here, dispatched at the very bottom (after every const/fn is
// initialized) so audit mode short-circuits the entire server module body.
const AUDIT_MODE = argv[0] === 'audit';

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

const server = createServer(async (req, res) => {
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
          // comments carry the Vercel bot's preview link; the PR body often
          // has it too (agents embed it per the completion gate).
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
      let bursts = 0;
      let worstFps = 60;
      const pages = new Set();
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if ((e.at ?? 0) < cutoff) continue;
        if (e.page) pages.add(e.page);
        if (e.kind === 'interaction') interactions.push(e);
        if (e.kind === 'long-render') {
          bursts += 1;
          if (typeof e.fps === 'number' && e.fps > 0) worstFps = Math.min(worstFps, e.fps);
        }
        for (const c of e.components ?? []) {
          const cur = byComponent.get(c.name) ?? {
            name: c.name,
            renders: 0,
            selfTime: 0,
            source: c.source ?? null,
            element: c.element ?? null,
            pages: new Set(),
            memoizableRenders: 0,
            changes: {},
          };
          cur.renders += c.renders ?? 1;
          cur.selfTime += c.selfTime ?? 0;
          cur.source ??= c.source ?? null;
          cur.element ??= c.element ?? null;
          if (e.page) cur.pages.add(e.page);
          if (c.memoizable) cur.memoizableRenders += c.renders ?? 1;
          for (const ch of c.changes ?? []) cur.changes[ch] = (cur.changes[ch] ?? 0) + 1;
          byComponent.set(c.name, cur);
        }
      }
      const components = [...byComponent.values()]
        .sort((a, b) => b.selfTime - a.selfTime)
        .slice(0, 25)
        .map((c) => ({ ...c, pages: [...c.pages] }));
      const md = [
        `# react-scan report (last ${Math.round(windowMs / 1000)}s)`,
        '',
        `Target 60 FPS — worst observed: ${worstFps} FPS across ${bursts} slow-frame burst(s).` +
          (pages.size ? ` Pages: ${[...pages].join(', ')}` : ''),
        '',
        '## Components (fix top-down; each line = who, where, and WHY it re-rendered)',
        ...components.map(
          (c) =>
            `- **${c.name}** — ${c.renders} renders · ${c.selfTime.toFixed(1)}ms self` +
            (c.memoizableRenders
              ? ` · ${c.memoizableRenders} renders with ZERO changes (memo() candidate)`
              : '') +
            (c.source ? ` · src \`${c.source}\`` : '') +
            (c.element ? ` · el \`${c.element}\`` : '') +
            (c.pages.length ? ` · on ${c.pages.join(', ')}` : '') +
            (Object.keys(c.changes).length
              ? ` · causes: ${Object.entries(c.changes)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 4)
                  .map(([k, v]) => `${k}×${v}`)
                  .join(', ')} — (fn)=unstable callback→useCallback, (ref)=new identity→useMemo/hoist`
              : ''),
        ),
        '',
        '## Recent interactions (what the user did → what re-rendered because of it)',
        ...interactions.slice(-10).flatMap((i) => [
          `- ${i.type ?? '?'} on **${i.target ?? '?'}**${i.page ? ` (${i.page})` : ''} — ${Math.round(i.duration ?? 0)}ms` +
            (i.slow ? ' ⚠ SLOW (>150ms INP)' : ''),
          ...(i.components ?? [])
            .slice(0, 4)
            .map(
              (c) =>
                `    ↳ ${c.name} ×${c.renders} · ${(c.selfTime ?? 0).toFixed(1)}ms` +
                (c.changes?.length ? ` · ${c.changes.join(', ')}` : '') +
                (c.source ? ` · \`${c.source}\`` : ''),
            ),
        ]),
      ].join('\n');
      return json(res, 200, {
        report: md,
        worstFps,
        bursts,
        pages: [...pages],
        components,
        interactions: interactions.slice(-20),
      });
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
});
if (!AUDIT_MODE)
  server.listen(PORT, '127.0.0.1', () => {
  const B = '\x1b[1m';
  const D = '\x1b[2m';
  const C = '\x1b[36m';
  const G = '\x1b[32m';
  const R = '\x1b[0m';
  console.log('');
  console.log(`${B}◆ linear-grab bridge${R} ${D}v${VERSION}${R}`);
  console.log(`${D}──────────────────────────────────────────────────${R}`);
  console.log(`  repo    ${C}${DIR}${R}`);
  console.log(`  listen  ${C}http://127.0.0.1:${PORT}${R} ${D}(localhost only)${R}`);
  console.log(`  agent   ${C}${CLAUDE_BIN} -p${R} ${D}(interactive stream-json)${R}`);
  console.log('');
  console.log(`${B}react-scan telemetry${R} ${D}(when the app loads react-scan-banihani)${R}`);
  console.log(`  events  ${G}.lineargrab/scan.ndjson${R} ${D}— newest last, gitignored${R}`);
  console.log(`  report  ${G}curl -s http://127.0.0.1:${PORT}/scan/report${R}`);
  console.log('');
  console.log(`${B}point Claude Code at the render logs${R} — paste one of these:`);
  console.log(`  ${D}»${R} Check the live render telemetry: read the newest lines of`);
  console.log(`    .lineargrab/scan.ndjson and summarize the slow components.`);
  console.log(`  ${D}»${R} curl -s http://127.0.0.1:${PORT}/scan/report ${D}(aggregated view)${R}`);
  console.log(`  ${D}tip: add a line to your repo's AGENTS.md/CLAUDE.md so agents find it`);
  console.log(`  on their own: "Live render telemetry: .lineargrab/scan.ndjson`);
  console.log(`  (react-scan via linear-grab bridge); aggregate: GET /scan/report"${R}`);
  console.log(`${D}──────────────────────────────────────────────────${R}`);
  loadHistory();
});

// ============================================================================
// audit — headless, CI-able design gate (raw CDP, zero deps)
// ============================================================================

// Colored console helpers, matching the bridge banner style.
const A = {
  B: '\x1b[1m',
  D: '\x1b[2m',
  C: '\x1b[36m',
  G: '\x1b[32m',
  Y: '\x1b[33m',
  Rd: '\x1b[31m',
  R: '\x1b[0m',
};
const alog = (s) => console.log(s);
const die = (msg) => {
  console.error(`${A.Rd}audit: ${msg}${A.R}`);
  process.exit(2);
};

/** Locate a Chromium-family browser. --chrome wins; else probe known paths. */
function findBrowser() {
  const explicit = flag('--chrome', null);
  if (explicit) {
    if (!existsSync(explicit)) die(`--chrome path does not exist: ${explicit}`);
    return explicit;
  }
  const probed = [];
  const os = platform();
  if (os === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const app of apps) {
      for (const root of ['/Applications', join(homedir(), 'Applications')]) {
        const p = join(root, app);
        probed.push(p);
        if (existsSync(p)) return p;
      }
    }
  } else if (os === 'linux') {
    for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      probed.push(name);
      const out = whichSync(name);
      if (out) return out;
    }
  } else if (os === 'win32') {
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const cands = [
      join(pf, 'Google/Chrome/Application/chrome.exe'),
      join(pf86, 'Google/Chrome/Application/chrome.exe'),
      join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    ];
    for (const p of cands) {
      probed.push(p);
      if (existsSync(p)) return p;
    }
  }
  die(
    `no Chrome/Edge/Brave/Chromium found. Probed:\n  ${probed.join('\n  ')}\nPass --chrome <path> to point at a browser binary.`,
  );
}

/** Resolve a binary via `which` (linux). Synchronous, best-effort. */
function whichSync(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Poll for the CDP DevToolsActivePort file; return ws:// endpoint. */
async function waitForEndpoint(tmp) {
  const portFile = join(tmp, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n');
      if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  die('browser did not open a debugging port within 15s (DevToolsActivePort never appeared)');
}

/** Minimal promise-based CDP client over one WebSocket. */
function makeCdp(ws) {
  let nextId = 1;
  const pending = new Map();
  // event listeners keyed by sessionId ('' = browser) → Map<method, Set<fn>>
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const sid = msg.sessionId ?? '';
      const byMethod = listeners.get(sid);
      const set = byMethod?.get(msg.method);
      if (set) for (const fn of [...set]) fn(msg.params ?? {});
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (method, sessionId, fn) => {
    const sid = sessionId ?? '';
    if (!listeners.has(sid)) listeners.set(sid, new Map());
    const byMethod = listeners.get(sid);
    if (!byMethod.has(method)) byMethod.set(method, new Set());
    byMethod.get(method).add(fn);
    return () => byMethod.get(method)?.delete(fn);
  };
  /** Resolve on the next matching event, or reject after ms. */
  const once = (method, sessionId, ms) =>
    new Promise((resolve, reject) => {
      const off = on(method, sessionId, (p) => {
        off();
        clearTimeout(t);
        resolve(p);
      });
      const t = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${method}`));
      }, ms);
    });
  return { send, on, once };
}

/** Read the slop-scan bundle once: local file next to the bridge, else CDN. */
async function loadBundleSource() {
  const local = new URL('./slop-scan.global.js', import.meta.url);
  try {
    return readFileSync(local, 'utf8');
  } catch {
    /* fall through to CDN */
  }
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/linear-grab@latest/dist/slop-scan.global.js');
    if (!res.ok) throw new Error(`CDN ${res.status}`);
    return await res.text();
  } catch (e) {
    die(
      `could not load the slop-scan bundle. Looked for ${local.pathname} and the jsDelivr CDN fallback (${e instanceof Error ? e.message : e}).`,
    );
  }
}

/** The audit itself. Returns the process exit code. */
async function runAudit() {
  if (typeof WebSocket === 'undefined') {
    die(`audit needs Node 22+ (built-in WebSocket); you have ${process.version}`);
  }

  const url = flag('--url', 'http://localhost:3000').replace(/\/+$/, '');
  const themeFlag = flag('--theme', 'both');
  const themes = themeFlag === 'both' ? ['light', 'dark'] : [themeFlag];
  const [vw, vh] = flag('--viewport', '1440x900')
    .split('x')
    .map((n) => Number(n) || 0);
  const settleMs = Number(flag('--wait', '1500'));
  const pageTimeout = Number(flag('--timeout', '30000'));
  const failOn = flag('--fail-on', 'error'); // error | warn | none
  const updateBaseline = argv.includes('--update-baseline');
  const auditDir = join(DIR, '.lineargrab');
  const outPath = flag('--out', join(auditDir, 'slop-report.md'));
  const baselinePath = join(auditDir, 'slop-baseline.json');
  const ndjsonPath = join(auditDir, 'scan.ndjson');

  // Routes: --routes, else auditRoutes in <DIR>/.lineargrab.json, else ['/'].
  let routes = flag('--routes', null)
    ?.split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (!routes || !routes.length) {
    try {
      const cfg = JSON.parse(readFileSync(join(DIR, '.lineargrab.json'), 'utf8'));
      if (Array.isArray(cfg.auditRoutes) && cfg.auditRoutes.length) routes = cfg.auditRoutes;
    } catch {
      /* no config */
    }
  }
  if (!routes || !routes.length) routes = ['/'];

  const BUNDLE_SOURCE = await loadBundleSource();
  const bin = findBrowser();

  // Auth: headless Chromium has no session — auth-gated routes would grade
  // the login page. `audit --login` opens a VISIBLE browser on a persistent
  // per-repo profile; sign in once, press Enter, and every later audit
  // reuses that profile (auto-detected). --fresh forces a clean throwaway.
  const defaultProfile = join(
    HISTORY_DIR,
    `audit-profile-${createHash('sha1').update(DIR).digest('hex').slice(0, 8)}`,
  );
  const explicitProfile = flag('--profile', null);
  const loginMode = argv.includes('--login');
  const fresh = argv.includes('--fresh');
  const persistentProfile =
    explicitProfile ?? (!fresh && (loginMode || existsSync(defaultProfile)) ? defaultProfile : null);

  if (loginMode) {
    const profile = persistentProfile ?? defaultProfile;
    mkdirSync(profile, { recursive: true });
    alog('');
    alog(`${A.B}◆ linear-grab audit --login${A.R}`);
    alog(`  A browser window is opening on ${A.C}${url}${A.R}.`);
    alog(`  Sign in there, then come back and press ${A.B}Enter${A.R} to save the session.`);
    alog(`  ${A.D}profile: ${profile}${A.R}`);
    const loginChild = spawn(
      bin,
      [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url],
      { stdio: 'ignore', detached: false },
    );
    await new Promise((resolve) => process.stdin.once('data', resolve));
    try {
      loginChild.kill('SIGTERM');
    } catch {
      /* already closed by the user */
    }
    alog(`${A.G}✓${A.R} session saved — future ${A.C}audit${A.R} runs use it automatically.`);
    return 0;
  }

  alog('');
  alog(`${A.B}◆ linear-grab audit${A.R} ${A.D}v${VERSION}${A.R}`);
  alog(`${A.D}──────────────────────────────────────────────────${A.R}`);
  alog(`  url      ${A.C}${url}${A.R}`);
  alog(`  routes   ${A.C}${routes.length}${A.R} ${A.D}${routes.join(', ')}${A.R}`);
  alog(`  themes   ${A.C}${themes.join(', ')}${A.R}`);
  alog(`  browser  ${A.C}${bin}${A.R}`);
  if (persistentProfile) alog(`  profile  ${A.C}${persistentProfile}${A.R} ${A.D}(signed-in session)${A.R}`);
  alog(`${A.D}──────────────────────────────────────────────────${A.R}`);

  const tmp = persistentProfile ?? mkdtempSync(join(tmpdir(), 'lg-audit-'));
  let child = null;
  let ws = null;
  const cleanup = () => {
    try {
      if (child && !child.killed) {
        child.kill('SIGTERM');
        const c = child;
        setTimeout(() => {
          try {
            c.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, 2000).unref?.();
      }
    } catch {
      /* ignore */
    }
    try {
      // Ephemeral profiles only — a signed-in persistent profile is the
      // user's saved session and must survive the run.
      if (!persistentProfile) rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  /** @type {Array<any>} */
  const allFindings = [];
  const failedRoutes = [];

  try {
    // A reused profile keeps the previous run's DevToolsActivePort — remove
    // it so waitForEndpoint can't connect to a dead port.
    try {
      rmSync(join(tmp, 'DevToolsActivePort'), { force: true });
    } catch {
      /* fresh profile */
    }
    child = spawn(
      bin,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${tmp}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    child.on('error', (e) => die(`failed to launch browser: ${e.message}`));

    const endpoint = await waitForEndpoint(tmp);
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    });
    const cdp = makeCdp(ws);

    // One reusable page target for the whole sweep.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: vw, height: vh, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    for (const route of routes) {
      const target = url + route;
      // Collect per-theme findings so we can dedupe across the two themes.
      /** @type {Map<string, any>} */
      const routeMap = new Map();

      for (const theme of themes) {
        const started = Date.now();
        await cdp.send(
          'Emulation.setEmulatedMedia',
          { features: [{ name: 'prefers-color-scheme', value: theme }] },
          sessionId,
        );

        const loaded = cdp.once('Page.loadEventFired', sessionId, pageTimeout).then(
          () => true,
          () => false,
        );
        await cdp.send('Page.navigate', { url: target }, sessionId);
        if (!(await loaded)) {
          failedRoutes.push({ route, theme, reason: `load timeout (>${pageTimeout}ms)` });
          alog(`  ${A.Rd}✗${A.R} ${padRoute(route)} ${padTheme(theme)} ${A.D}load timeout${A.R}`);
          continue;
        }
        await new Promise((r) => setTimeout(r, settleMs));

        // Inject the scan bundle.
        const inj = await cdp.send(
          'Runtime.evaluate',
          { expression: BUNDLE_SOURCE, returnByValue: false },
          sessionId,
        );
        if (inj.exceptionDetails) {
          const reason = inj.exceptionDetails.exception?.description ?? 'inject failed';
          failedRoutes.push({ route, theme, reason });
          alog(`  ${A.Rd}✗${A.R} ${padRoute(route)} ${padTheme(theme)} ${A.D}${reason.slice(0, 60)}${A.R}`);
          continue;
        }

        // Lazy content mounts on scroll (marketing sections, consent banners,
        // virtualized lists) — sweep to the bottom and back so the DOM we
        // grade is the DOM users actually see, not a timing accident.
        await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(async () => {
              const d = document.scrollingElement || document.documentElement;
              const step = Math.max(400, innerHeight * 0.8);
              for (let y = 0; y < d.scrollHeight && y < 20000; y += step) {
                scrollTo(0, y);
                await new Promise((r) => setTimeout(r, 120));
              }
              scrollTo(0, 0);
              await new Promise((r) => setTimeout(r, 400));
            })()`,
            awaitPromise: true,
            returnByValue: false,
          },
          sessionId,
        );

        // Run it — until two consecutive scans agree. Dynamic pages settle
        // over a second or two; a single-shot scan makes the baseline flaky
        // ("9 new findings" on an unchanged page = the gate crying wolf).
        let findings = null;
        let scanFailed = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const evalRes = await cdp.send(
            'Runtime.evaluate',
            {
              // Attributed run resolves Component @ file:line via the page's
              // own react-grab (loaded by linear-grab's script tag); falls
              // back to the sync scan on older bundles.
              expression:
                '__SLOP_SCAN__.runAttributed ? __SLOP_SCAN__.runAttributed() : __SLOP_SCAN__.run()',
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId,
          );
          if (evalRes.exceptionDetails) {
            scanFailed = evalRes.exceptionDetails.exception?.description ?? 'scan threw';
            break;
          }
          const next = Array.isArray(evalRes.result?.value) ? evalRes.result.value : [];
          if (findings && next.length === findings.length) {
            findings = next;
            break;
          }
          findings = next;
          await new Promise((r) => setTimeout(r, 600));
        }
        if (scanFailed) {
          failedRoutes.push({ route, theme, reason: scanFailed });
          alog(`  ${A.Rd}✗${A.R} ${padRoute(route)} ${padTheme(theme)} ${A.D}${scanFailed.slice(0, 60)}${A.R}`);
          continue;
        }
        findings ??= [];

        // Dedupe across themes within this route.
        for (const f of findings) {
          const key = `${f.ruleId}|${f.selector}|${f.evidence}`;
          const existing = routeMap.get(key);
          if (existing) {
            if (!existing.themes.includes(theme)) existing.themes.push(theme);
          } else {
            routeMap.set(key, { ...f, route, themes: [theme] });
          }
        }

        const errs = findings.filter((f) => f.severity === 'error').length;
        const warns = findings.filter((f) => f.severity === 'warn').length;
        alog(
          `  ${A.G}✓${A.R} ${padRoute(route)} ${padTheme(theme)} ` +
            `${String(errs).padStart(4)} ${A.D}errors${A.R}  ${String(warns).padStart(3)} ${A.D}warns${A.R} ` +
            `${A.D}${Date.now() - started}ms${A.R}`,
        );
      }
      for (const f of routeMap.values()) allFindings.push(f);
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    process.off('SIGINT', onSigint);
    cleanup();
  }

  // ---- baseline ------------------------------------------------------------
  const bkey = (f) => `${f.ruleId}|${f.route}|${f.selector}`;
  const currentKeys = [...new Set(allFindings.map(bkey))];

  bootstrapAuditDir(auditDir);

  if (updateBaseline) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ createdAt: new Date().toISOString(), keys: currentKeys }, null, 2),
    );
    alog('');
    alog(`${A.G}✓${A.R} baseline updated — ${A.B}${currentKeys.length}${A.R} keys recorded`);
    alog(`  ${A.D}${baselinePath}${A.R}`);
    // Still write the report + ndjson so the artifacts stay in sync.
    for (const f of allFindings) f.isNew = false;
    writeReportAndNdjson(allFindings, {
      url,
      routes,
      themes,
      outPath,
      ndjsonPath,
      newCount: 0,
    });
    return 0;
  }

  let baselineKeys = null;
  let hasBaseline = false;
  try {
    baselineKeys = new Set(JSON.parse(readFileSync(baselinePath, 'utf8')).keys ?? []);
    hasBaseline = true;
  } catch {
    /* no baseline yet */
  }

  for (const f of allFindings) f.isNew = hasBaseline ? !baselineKeys.has(bkey(f)) : true;
  const newFindings = allFindings.filter((f) => f.isNew);

  // ---- write artifacts -----------------------------------------------------
  const totalErr = allFindings.filter((f) => f.severity === 'error').length;
  const totalWarn = allFindings.filter((f) => f.severity === 'warn').length;
  writeReportAndNdjson(allFindings, {
    url,
    routes,
    themes,
    outPath,
    ndjsonPath,
    newCount: newFindings.length,
  });

  // ---- exit decision -------------------------------------------------------
  const gate =
    failOn === 'none'
      ? []
      : failOn === 'warn'
        ? newFindings.filter((f) => f.severity === 'error' || f.severity === 'warn')
        : newFindings.filter((f) => f.severity === 'error');
  const willFail = gate.length > 0;

  alog('');
  alog(`${A.D}──────────────────────────────────────────────────${A.R}`);
  alog(
    `  ${A.B}totals${A.R}  ${totalErr} errors  ${totalWarn} warns  ` +
      `across ${routes.length} route(s) × ${themes.length} theme(s)`,
  );
  if (failedRoutes.length) {
    alog(`  ${A.Y}${failedRoutes.length} route-theme sweep(s) failed${A.R} ${A.D}(see ✗ above)${A.R}`);
  }
  if (!hasBaseline) {
    alog(
      `  ${A.Y}no baseline${A.R} — all ${newFindings.length} findings count as NEW. ` +
        `Run ${A.C}--update-baseline${A.R} to create the ratchet.`,
    );
  } else {
    alog(`  ${A.B}new vs baseline${A.R}  ${newFindings.length} findings`);
  }
  alog(`  report  ${A.C}${outPath}${A.R}`);
  if (willFail) {
    alog(
      `  ${A.Rd}${A.B}FAIL${A.R} — ${gate.length} new ${failOn === 'warn' ? 'error/warn' : 'error'}-severity finding(s) (fail-on=${failOn})`,
    );
  } else {
    alog(`  ${A.G}${A.B}PASS${A.R} — 0 new findings at/above fail-on=${failOn}`);
  }
  alog(`${A.D}──────────────────────────────────────────────────${A.R}`);
  return willFail ? 1 : 0;
}

const padRoute = (r) => r.slice(0, 24).padEnd(24);
const padTheme = (t) => t.padEnd(5);

/** Bootstrap the .lineargrab dir + self-gitignore (mirrors /scan/events). */
function bootstrapAuditDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch {
    /* exists */
  }
}

/** Append audit findings to scan.ndjson with the same rotation as telemetry. */
function appendNdjson(file, findings) {
  const lines =
    findings
      .slice(0, 5000)
      .map((f) =>
        JSON.stringify({
          kind: 'slop-scan',
          mode: 'headless',
          route: f.route,
          themes: f.themes,
          at: Date.now(),
          ruleId: f.ruleId,
          part: f.part,
          severity: f.severity,
          description: f.description,
          selector: f.selector,
          evidence: f.evidence,
          component: f.component ?? null,
          source: f.source ?? null,
          isNew: !!f.isNew,
        }),
      )
      .join('\n') + '\n';
  try {
    appendFileSync(file, lines);
    const size = statSync(file).size;
    if (size > 2_000_000) {
      const keep = readFileSync(file, 'utf8');
      writeFileSync(file, keep.slice(Math.floor(keep.length / 2)).replace(/^[^\n]*\n/, ''));
    }
  } catch {
    /* disk issues — never fail the audit on telemetry */
  }
}

/** Write the markdown report + append NDJSON events. */
function writeReportAndNdjson(findings, { url, routes, themes, outPath, ndjsonPath, newCount }) {
  const totalErr = findings.filter((f) => f.severity === 'error').length;
  const totalWarn = findings.filter((f) => f.severity === 'warn').length;

  const lines = [
    '# Design slop-scan report',
    '',
    `- **url**: ${url}`,
    `- **routes**: ${routes.length} (${routes.join(', ')})`,
    `- **themes**: ${themes.join(', ')}`,
    `- **totals**: ${totalErr} errors / ${totalWarn} warns`,
    `- **new vs baseline**: ${newCount}`,
    `- **generated**: ${new Date().toISOString()}`,
    '',
  ];

  // Group by route → rule. Errors first, then by count desc.
  const byRoute = new Map();
  for (const f of findings) {
    if (!byRoute.has(f.route)) byRoute.set(f.route, []);
    byRoute.get(f.route).push(f);
  }
  for (const route of routes) {
    const rf = byRoute.get(route);
    if (!rf || !rf.length) continue;
    lines.push(`## ${route}`, '');
    const byRule = new Map();
    for (const f of rf) {
      if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
      byRule.get(f.ruleId).push(f);
    }
    const rules = [...byRule.entries()].sort((a, b) => {
      const sev = (list) => (list.some((x) => x.severity === 'error') ? 0 : 1);
      return sev(a[1]) - sev(b[1]) || b[1].length - a[1].length;
    });
    for (const [ruleId, list] of rules) {
      const head = list[0];
      const sevBadge = head.severity === 'error' ? 'error' : 'warn';
      lines.push(
        `### ${ruleId} \`(${sevBadge})\`${head.part ? ` §${head.part}` : ''}`,
        head.description ? `${head.description}` : '',
        '',
      );
      for (const f of list) {
        const where = f.component || f.source ? ` — ${[f.component, f.source].filter(Boolean).join(' @ ')}` : '';
        lines.push(
          `- \`${f.selector}\` — ${f.evidence}${where} [${f.themes.join('/')}]${f.isNew ? ' **NEW**' : ''}`,
        );
      }
      lines.push('');
    }
  }

  try {
    mkdirSync(join(outPath, '..'), { recursive: true });
  } catch {
    /* ignore */
  }
  writeFileSync(outPath, lines.join('\n'));
  appendNdjson(ndjsonPath, findings);
}

// Dispatch audit LAST — every const/fn above is now initialized, so no TDZ.
if (AUDIT_MODE) {
  const code = await runAudit();
  process.exit(code);
}
