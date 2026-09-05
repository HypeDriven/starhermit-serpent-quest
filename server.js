// Serpent Quest — authoritative game script (StarHermit `server` entry).
//
// Scope (per spec §6): seeded daily sessions, replay validation, durable
// achievement delivery, and leaderboard storage. Ordinary practice runs
// locally on the client and never touches this script.
//
// Runs two ways:
//   1. Embedded by the host shell:  import { handlers } from './server.js'
//   2. Standalone for verification: node server.js [port]   (serves /api/v1/*)
//
// No secrets, no external services; state is in-memory per process.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReplay, RULES_VERSION } from './js/rules.js';
import { dailyConfig, toRulesConfig, CONTENT_VERSION } from './js/content.js';
import { hashString } from './js/rng.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// Serve a static asset from the game folder; falls back to index.html for '/'.
async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = resolve(join(ROOT, normalize(rel)));
  if (!filePath.startsWith(resolve(ROOT))) return json(res, 404, { error: 'not-found' });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not-found' });
  }
}

const MAX_LOG_COMMANDS = 20000;
const boards = new Map();      // boardId -> Map(playerId -> entry)
const achievements = new Map(); // playerId -> Set(key)
const excludedDays = new Set(); // defective dailies excluded from ranking

const ACHIEVEMENT_KEYS = new Set([
  'first-clear', 'mechanic-mastery', 'daily-streak-3', 'grand-milestone', 'seasoned-gardener',
]);

// Spec §2 tie-break order: primary objective completion, fewer invalid actions,
// lower authoritative elapsed time, then stable session identifier.
function boardCompare(a, b) {
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if ((a.invalidActions || 0) !== (b.invalidActions || 0)) {
    return (a.invalidActions || 0) - (b.invalidActions || 0);
  }
  if ((a.durationMs || 0) !== (b.durationMs || 0)) {
    return (a.durationMs || 0) - (b.durationMs || 0);
  }
  return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

// Validate a score claim by re-simulating the ordered input log against the
// immutable daily seed. Reject impossible or stale-version scores.
export function validateScoreClaim(claim) {
  if (!claim || typeof claim !== 'object') return { ok: false, error: 'malformed-claim' };
  if (claim.contentVersion !== CONTENT_VERSION) return { ok: false, error: 'stale-version' };
  if (claim.rulesetId !== 'daily-v1') return { ok: false, error: 'unsupported-ruleset' };
  if (typeof claim.day !== 'string' || excludedDays.has(claim.day)) return { ok: false, error: 'day-excluded' };
  if (!Array.isArray(claim.inputLog) || claim.inputLog.length > MAX_LOG_COMMANDS) {
    return { ok: false, error: 'bad-input-log' };
  }
  const desc = dailyConfig(new Date(claim.day + 'T00:00:00Z'));
  if (desc.seed !== claim.seed) return { ok: false, error: 'seed-mismatch' };
  if (claim.settings && claim.settings.tickScale && claim.settings.tickScale !== 1) {
    return { ok: false, error: 'assisted-settings' }; // timing assist is unranked
  }
  const config = toRulesConfig(desc);
  const { finalHash, state } = runReplay(config, claim.inputLog);
  if (typeof claim.checksum === 'string' && claim.checksum !== finalHash) {
    return { ok: false, error: 'checksum-mismatch', finalHash };
  }
  const claimed = claim.score || {};
  const actual = state.score;
  for (const k of ['food', 'growth', 'rivals', 'survival', 'objective', 'total']) {
    if (claimed[k] !== undefined && claimed[k] !== actual[k]) {
      return { ok: false, error: 'score-mismatch', component: k, actual: actual[k] };
    }
  }
  return {
    ok: true, score: actual, won: state.status === 'won', ticks: state.tick,
    invalidActions: state.stats.invalidActions, finalHash,
  };
}

export const handlers = {
  'GET /time': async () => ({ now: Date.now(), rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION }),

  'POST /scores': async (req, playerId) => {
    const claim = await readBody(req);
    const verdict = validateScoreClaim(claim);
    if (!verdict.ok) return { status: 422, body: { error: verdict.error, detail: verdict } };
    const boardId = 'daily:' + claim.day;
    if (!boards.has(boardId)) boards.set(boardId, new Map());
    const board = boards.get(boardId);
    const entry = {
      playerId, score: verdict.score.total, won: verdict.won, ticks: verdict.ticks,
      invalidActions: verdict.invalidActions, sessionId: claim.sessionId,
      durationMs: Math.min(claim.durationMs || 0, 3600000), at: Date.now(),
    };
    const prev = board.get(playerId);
    if (!prev || boardCompare(entry, prev) < 0) {
      board.set(playerId, entry);
    }
    return { status: 200, body: { accepted: true, casual: false, best: board.get(playerId) } };
  },

  'GET /boards/:id': async (_req, _playerId, params) => {
    const board = boards.get(params.id);
    const entries = board ? [...board.values()].sort(boardCompare).slice(0, 50) : [];
    return { status: 200, body: { entries, casual: false } };
  },

  // Durable, idempotent achievement delivery.
  'POST /achievements': async (req, playerId) => {
    const { key } = await readBody(req);
    if (!ACHIEVEMENT_KEYS.has(key)) return { status: 422, body: { error: 'unknown-achievement' } };
    if (!achievements.has(playerId)) achievements.set(playerId, new Set());
    achievements.get(playerId).add(key); // idempotent by Set semantics
    return { status: 200, body: { unlocked: [...achievements.get(playerId)] } };
  },

  'POST /activity/start': async () => ({ status: 204 }),
  'POST /activity/end': async () => ({ status: 204 }),
  'POST /presence': async () => ({ status: 204 }),
  'POST /telemetry': async () => ({ status: 204 }),
  'GET /friends': async () => ({ status: 200, body: { friends: [] } }),
};

export function route(method, path) {
  for (const pattern of Object.keys(handlers)) {
    const [m, p] = pattern.split(' ');
    if (m !== method) continue;
    const pp = p.split('/');
    const ap = path.split('/');
    if (pp.length !== ap.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { match = false; break; }
    }
    if (match) return { handler: handlers[pattern], params };
  }
  return null;
}

// Standalone mode: node server.js [port]  (PORT env also honored)
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 8787;
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/v1/')) {
      return serveStatic(res, url.pathname);
    }
    const found = route(req.method, url.pathname.slice('/api/v1'.length));
    if (!found) return json(res, 404, { error: 'not-found' });
    // Player identity: the host shell normally injects this from the account
    // token. Standalone mode accepts an explicit header for local testing.
    const playerId = 'p-' + hashString(String(req.headers.authorization || 'anonymous'));
    try {
      const out = await found.handler(req, playerId, found.params || {});
      if (typeof out === 'object' && out && 'status' in out) {
        if (out.status === 204) { res.writeHead(204); res.end(); return; }
        json(res, out.status, out.body ?? {});
      } else {
        json(res, 200, out);
      }
    } catch (e) {
      json(res, e.message === 'payload-too-large' ? 413 : 400, { error: e.message });
    }
  }).listen(port, () => console.log(`serpent-quest authoritative script on :${port}`));
}
