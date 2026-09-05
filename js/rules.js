// Serpent Quest — pure deterministic rules engine.
// No DOM, no rendering, no timers. All state is JSON-serializable.
// Consumers: session (play), tutorials/hints (legal-action API), replays, tests,
// and the authoritative server script.

import { createRng, nextInt, nextFloat, canonicalJson, hashString } from './rng.js';

export const RULES_VERSION = 1;

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
export const DIR_NAMES = ['up', 'down', 'left', 'right'];

export const FOOD_KINDS = {
  berry: { value: 10, grow: 1 },
  golden: { value: 50, grow: 2 },
};

export const SCORE = {
  GROWTH_PER_SEGMENT: 5,
  RIVAL_DEFEAT: 100,
  SURVIVAL_PER_TICKS: 10, // 1 point per this many ticks, awarded at end
  OBJECTIVE_COMPLETE: 250,
  PAR_TICK_BONUS: 2, // per tick under par when winning
};

const TERMINAL_REASONS = new Set([
  'objective-complete',
  'crashed-wall',
  'crashed-self',
  'crashed-obstacle',
  'eaten-by-rival',
  'moves-exhausted',
  'time-up',
  'abandoned',
]);

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

// config: {
//   seed, grid: {w,h}, themeId?,
//   start: {x,y,dir,length},
//   food: { count, goldenChance },        // goldenChance in [0,1]
//   rivals: [{ tier:'small'|'big', length, x?, y? }],
//   obstacles: [{x,y}],                   // materialized by content module
//   goals: [{ kind:'food'|'length'|'rivals'|'survive'|'score', count }],
//   tickMs, parTicks?, maxTicks?, moveLimit?,
//   mechanics: { allowUndo?, rivalsEatFood? },
// }
export function createGame(config) {
  validateConfig(config);
  const rng = createRng(config.seed);
  const obstacles = dedupeCells(config.obstacles || []);
  const occ = new Set(obstacles.map(cellKey));

  const start = config.start;
  const body = [];
  const d = DIRS[start.dir];
  for (let i = 0; i < start.length; i++) {
    body.push({ x: start.x - d.x * i, y: start.y - d.y * i });
  }
  for (const c of body) occ.add(cellKey(c));

  const rivals = (config.rivals || []).map((r, i) => {
    const pos = r.x !== undefined ? { x: r.x, y: r.y } : findFreeCell(rng, config.grid, occ, 3);
    const rbody = [{ x: pos.x, y: pos.y }];
    const rdir = DIR_NAMES[nextInt(rng, 4)];
    const rd = DIRS[rdir];
    for (let k = 1; k < r.length; k++) {
      rbody.push(clampCell({ x: pos.x - rd.x * k, y: pos.y - rd.y * k }, config.grid));
    }
    for (const c of rbody) occ.add(cellKey(c));
    return { id: 'r' + i, tier: r.tier, dir: rdir, body: rbody, alive: true, growPending: 0 };
  });

  const state = {
    version: RULES_VERSION,
    seed: config.seed >>> 0,
    tick: 0,
    rngState: rng.state,
    grid: { w: config.grid.w, h: config.grid.h },
    snake: {
      dir: start.dir,
      queuedDir: null,
      body,
      growPending: 0,
      alive: true,
    },
    food: [],
    rivals,
    obstacles,
    goals: (config.goals || []).map((g) => ({ kind: g.kind, count: g.count, progress: 0, done: false })),
    score: { food: 0, growth: 0, rivals: 0, survival: 0, objective: 0, total: 0 },
    stats: {
      invalidActions: 0,
      commands: 0,
      foodEaten: 0,
      rivalsDefeated: 0,
      maxLength: body.length,
    },
    status: 'active',
    terminalReason: null,
    config: {
      tickMs: config.tickMs || 140,
      parTicks: config.parTicks || 0,
      maxTicks: config.maxTicks || 0,
      moveLimit: config.moveLimit || 0,
      goldenChance: config.food ? config.food.goldenChance || 0 : 0,
      foodCount: config.food ? config.food.count : 3,
      mechanics: config.mechanics || {},
    },
  };

  for (let i = 0; i < state.config.foodCount; i++) spawnFood(state);
  updateGoals(state);
  return state;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('config required');
  if (!Number.isInteger(config.seed)) throw new Error('config.seed must be an integer');
  const { w, h } = config.grid || {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 6 || h < 6 || w > 64 || h > 64) {
    throw new Error('grid must be 6..64 per side');
  }
  const s = config.start;
  if (!s || !DIRS[s.dir]) throw new Error('start.dir invalid');
  if (s.x < 0 || s.y < 0 || s.x >= w || s.y >= h) throw new Error('start out of bounds');
}

function clampCell(c, grid) {
  return { x: Math.max(0, Math.min(grid.w - 1, c.x)), y: Math.max(0, Math.min(grid.h - 1, c.y)) };
}

function dedupeCells(cells) {
  const seen = new Set();
  const out = [];
  for (const c of cells) {
    const k = cellKey(c);
    if (!seen.has(k)) { seen.add(k); out.push({ x: c.x, y: c.y }); }
  }
  return out;
}

export function cellKey(c) {
  return c.x + ',' + c.y;
}

function occupiedSet(state, { includeFood = false } = {}) {
  const occ = new Set();
  for (const c of state.obstacles) occ.add(cellKey(c));
  for (const c of state.snake.body) occ.add(cellKey(c));
  for (const r of state.rivals) if (r.alive) for (const c of r.body) occ.add(cellKey(c));
  if (includeFood) for (const f of state.food) occ.add(cellKey(f));
  return occ;
}

function findFreeCell(rng, grid, occ, margin = 0) {
  for (let tries = 0; tries < 500; tries++) {
    const c = {
      x: margin + nextInt(rng, Math.max(1, grid.w - margin * 2)),
      y: margin + nextInt(rng, Math.max(1, grid.h - margin * 2)),
    };
    if (!occ.has(cellKey(c))) return c;
  }
  // Fallback: first free cell scanning in order (still deterministic).
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      if (!occ.has(x + ',' + y)) return { x, y };
    }
  }
  return null; // grid completely full
}

function rulesRng(state) {
  // Rehydrate a stream positioned at the stored state; callers persist it back.
  return { state: state.rngState >>> 0 };
}

function spawnFood(state) {
  const rng = rulesRng(state);
  const occ = occupiedSet(state, { includeFood: true });
  const cell = findFreeCell(rng, state.grid, occ);
  state.rngState = rng.state;
  if (!cell) return false;
  const kind = rulesRngFresh(state) < state.config.goldenChance ? 'golden' : 'berry';
  state.food.push({ x: cell.x, y: cell.y, kind });
  return true;
}

// Draws from the rules stream and persists immediately (for one-off rolls).
function rulesRngFresh(state) {
  const rng = rulesRng(state);
  const v = nextFloat(rng);
  state.rngState = rng.state;
  return v;
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

// Every action the player may take right now. Tutorials and hints call this
// exact API; play never bypasses it.
export function getLegalActions(state) {
  if (state.status !== 'active') return [];
  const actions = [];
  const effective = state.snake.dir;
  for (const name of DIR_NAMES) {
    const err = turnError(state, name, effective);
    if (!err) actions.push({ type: 'turn', dir: name, id: 'turn:' + name });
  }
  return actions;
}

function turnError(state, dir, effective) {
  if (state.status !== 'active') return { code: 'game-over', reason: 'The round is already over.' };
  if (!DIRS[dir]) return { code: 'bad-direction', reason: 'Unknown direction.' };
  const cur = DIRS[effective || state.snake.dir];
  const nxt = DIRS[dir];
  if (cur.x + nxt.x === 0 && cur.y + nxt.y === 0) {
    return { code: 'reverse', reason: 'The serpent cannot reverse into itself.' };
  }
  return null;
}

// Suggested safe directions for hints: legal turns whose next cell is not lethal.
export function getSafeTurns(state) {
  return getLegalActions(state).filter((a) => {
    const head = state.snake.body[0];
    const d = DIRS[a.dir];
    const cell = { x: head.x + d.x, y: head.y + d.y };
    return !isLethalCell(state, cell);
  });
}

function isLethalCell(state, cell) {
  if (cell.x < 0 || cell.y < 0 || cell.x >= state.grid.w || cell.y >= state.grid.h) return true;
  const k = cellKey(cell);
  for (const c of state.obstacles) if (cellKey(c) === k) return true;
  const body = state.snake.body;
  const tailVacates = state.snake.growPending <= 0;
  const limit = tailVacates ? body.length - 1 : body.length;
  for (let i = 0; i < limit; i++) if (cellKey(body[i]) === k) return true;
  for (const r of state.rivals) {
    if (!r.alive || r.tier !== 'big') continue;
    for (const c of r.body) if (cellKey(c) === k) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commands (player intent; validated, never mutate on failure)
// ---------------------------------------------------------------------------

export function applyCommand(state, command) {
  if (!command || typeof command !== 'object') {
    return { state, events: [], error: { code: 'malformed', reason: 'Command is not an object.' } };
  }
  if (command.type === 'turn') {
    const err = turnError(state, command.dir, state.snake.dir);
    if (err) {
      const next = cloneState(state);
      next.stats.invalidActions += 1;
      return { state: next, events: [{ type: 'invalid', reason: err.reason, code: err.code }], error: err };
    }
    const next = cloneState(state);
    next.stats.commands += 1;
    next.snake.queuedDir = command.dir;
    return { state: next, events: [{ type: 'turn', dir: command.dir }], error: null };
  }
  return { state, events: [], error: { code: 'unknown-command', reason: 'Unknown command type.' } };
}

// ---------------------------------------------------------------------------
// Simulation tick — the only place state advances.
// ---------------------------------------------------------------------------

export function advanceTick(prev) {
  if (prev.status !== 'active') return { state: prev, events: [] };
  const state = cloneState(prev);
  const events = [];
  state.tick += 1;

  const snake = state.snake;

  // 1. Commit queued turn (validated again against the current direction).
  if (snake.queuedDir) {
    const err = turnError(state, snake.queuedDir, snake.dir);
    if (!err) snake.dir = snake.queuedDir;
    snake.queuedDir = null;
  }

  // 2. Resolve the player head move.
  const d = DIRS[snake.dir];
  const head = snake.body[0];
  const target = { x: head.x + d.x, y: head.y + d.y };
  const tKey = cellKey(target);

  if (target.x < 0 || target.y < 0 || target.x >= state.grid.w || target.y >= state.grid.h) {
    return terminate(state, events, 'lost', 'crashed-wall', target);
  }
  if (state.obstacles.some((c) => cellKey(c) === tKey)) {
    return terminate(state, events, 'lost', 'crashed-obstacle', target);
  }
  const tailVacates = snake.growPending <= 0;
  const selfLimit = tailVacates ? snake.body.length - 1 : snake.body.length;
  for (let i = 0; i < selfLimit; i++) {
    if (cellKey(snake.body[i]) === tKey) {
      return terminate(state, events, 'lost', 'crashed-self', target);
    }
  }
  for (const r of state.rivals) {
    if (!r.alive) continue;
    if (r.tier === 'big' && r.body.some((c) => cellKey(c) === tKey)) {
      return terminate(state, events, 'lost', 'eaten-by-rival', target);
    }
  }

  // Small rivals are prey: entering any of their cells defeats them.
  const prey = state.rivals.find((r) => r.alive && r.tier === 'small' && r.body.some((c) => cellKey(c) === tKey));
  if (prey) {
    prey.alive = false;
    snake.growPending += 1;
    state.score.rivals += SCORE.RIVAL_DEFEAT;
    state.stats.rivalsDefeated += 1;
    events.push({ type: 'rival-defeated', id: prey.id, cell: { ...target } });
  }

  // 3. Move the serpent.
  snake.body.unshift(target);
  if (snake.growPending > 0) {
    snake.growPending -= 1;
    state.score.growth += SCORE.GROWTH_PER_SEGMENT;
    events.push({ type: 'grow', length: snake.body.length });
  } else {
    snake.body.pop();
  }
  if (snake.body.length > state.stats.maxLength) state.stats.maxLength = snake.body.length;

  // 4. Eat food at the new head cell.
  const foodIdx = state.food.findIndex((f) => cellKey(f) === tKey);
  if (foodIdx >= 0) {
    const food = state.food[foodIdx];
    state.food.splice(foodIdx, 1);
    const def = FOOD_KINDS[food.kind] || FOOD_KINDS.berry;
    state.score.food += def.value;
    snake.growPending += def.grow;
    state.stats.foodEaten += 1;
    events.push({ type: 'eat', kind: food.kind, cell: { ...food } });
    spawnFood(state);
    events.push({ type: 'food-spawned' });
  }

  // 5. Move rivals (big every tick, small every second tick).
  for (const r of state.rivals) {
    if (!r.alive) continue;
    if (r.tier === 'small' && state.tick % 2 !== 0) continue;
    const res = moveRival(state, r);
    if (res.killedPlayer) {
      return terminate(state, events, 'lost', 'eaten-by-rival', { ...r.body[0] });
    }
    if (res.rivalDied) {
      r.alive = false;
      state.score.rivals += SCORE.RIVAL_DEFEAT;
      state.stats.rivalsDefeated += 1;
      events.push({ type: 'rival-defeated', id: r.id, cell: { ...r.body[0] } });
    }
    if (res.ateFood) events.push({ type: 'rival-ate', id: r.id });
  }

  // 6. Goals, limits, terminal checks.
  updateGoals(state);
  if (state.goals.length > 0 && state.goals.every((g) => g.done)) {
    state.score.objective += SCORE.OBJECTIVE_COMPLETE * state.goals.length;
    if (state.config.parTicks > 0 && state.tick < state.config.parTicks) {
      state.score.objective += (state.config.parTicks - state.tick) * SCORE.PAR_TICK_BONUS;
    }
    return terminate(state, events, 'won', 'objective-complete', target);
  }
  if (state.config.moveLimit > 0 && state.stats.commands >= state.config.moveLimit) {
    return terminate(state, events, 'lost', 'moves-exhausted', target);
  }
  if (state.config.maxTicks > 0 && state.tick >= state.config.maxTicks) {
    return terminate(state, events, 'lost', 'time-up', target);
  }

  finalizeScore(state);
  return { state, events };
}

function moveRival(state, r) {
  const res = { killedPlayer: false, rivalDied: false, ateFood: false };
  const rng = rulesRng(state);
  const head = r.body[0];
  const playerHead = state.snake.body[0];

  const options = [];
  for (const name of DIR_NAMES) {
    const d = DIRS[name];
    const cur = DIRS[r.dir];
    if (cur.x + d.x === 0 && cur.y + d.y === 0 && r.body.length > 1) continue; // no reverse
    const cell = { x: head.x + d.x, y: head.y + d.y };
    if (cell.x < 0 || cell.y < 0 || cell.x >= state.grid.w || cell.y >= state.grid.h) continue;
    const k = cellKey(cell);
    if (state.obstacles.some((c) => cellKey(c) === k)) continue;
    if (r.body.some((c, i) => i < r.body.length - 1 && cellKey(c) === k)) continue;
    if (state.rivals.some((o) => o !== r && o.alive && o.body.some((c) => cellKey(c) === k))) continue;
    options.push({ name, cell });
  }
  state.rngState = rng.state;
  if (options.length === 0) return res; // boxed in: wait

  const dist = (c) => Math.abs(c.x - playerHead.x) + Math.abs(c.y - playerHead.y);
  let chosen;
  if (r.tier === 'big') {
    options.sort((a, b) => dist(a.cell) - dist(b.cell));
    const best = dist(options[0].cell);
    const ties = options.filter((o) => dist(o.cell) === best);
    const r2 = rulesRng(state);
    chosen = ties[nextInt(r2, ties.length)];
    state.rngState = r2.state;
  } else {
    // Small rivals flee the player, prefer food when adjacent-ish, else wander.
    const foodNear = state.food
      .map((f) => ({ f, d: Math.abs(f.x - head.x) + Math.abs(f.y - head.y) }))
      .sort((a, b) => a.d - b.d)[0];
    const r2 = rulesRng(state);
    if (foodNear && foodNear.d <= 3) {
      options.sort((a, b) =>
        (Math.abs(a.cell.x - foodNear.f.x) + Math.abs(a.cell.y - foodNear.f.y)) -
        (Math.abs(b.cell.x - foodNear.f.x) + Math.abs(b.cell.y - foodNear.f.y)));
      chosen = options[0];
    } else {
      options.sort((a, b) => dist(b.cell) - dist(a.cell));
      const best = dist(options[0].cell);
      const ties = options.filter((o) => dist(o.cell) === best);
      chosen = ties[nextInt(r2, ties.length)];
    }
    state.rngState = r2.state;
  }

  r.dir = chosen.name;
  const intoPlayer = state.snake.body.some((c) => cellKey(c) === cellKey(chosen.cell));
  r.body.unshift(chosen.cell);
  if (r.growPending > 0) r.growPending -= 1;
  else r.body.pop();

  if (intoPlayer) {
    if (r.tier === 'big') res.killedPlayer = true;
    else res.rivalDied = true; // small rivals dash themselves against the player
    return res;
  }

  if (r.tier === 'small') {
    const fi = state.food.findIndex((f) => cellKey(f) === cellKey(chosen.cell));
    if (fi >= 0) {
      state.food.splice(fi, 1);
      r.growPending += 1;
      if (r.body.length >= 8) r.tier = 'big'; // a well-fed rival becomes a threat
      spawnFood(state);
      res.ateFood = true;
    }
  }
  return res;
}

function updateGoals(state) {
  for (const g of state.goals) {
    switch (g.kind) {
      case 'food': g.progress = state.stats.foodEaten; break;
      case 'length': g.progress = state.snake.body.length; break;
      case 'rivals': g.progress = state.stats.rivalsDefeated; break;
      case 'survive': g.progress = state.tick; break;
      case 'score': {
        finalizeScore(state);
        g.progress = state.score.total;
        break;
      }
    }
    g.done = g.progress >= g.count;
  }
}

function finalizeScore(state) {
  state.score.survival = Math.floor(state.tick / SCORE.SURVIVAL_PER_TICKS);
  const s = state.score;
  s.total = s.food + s.growth + s.rivals + s.survival + s.objective;
}

function terminate(state, events, status, reason, cell) {
  if (!TERMINAL_REASONS.has(reason)) throw new Error('bad terminal reason: ' + reason);
  state.status = status;
  state.terminalReason = reason;
  state.snake.alive = status === 'won';
  events.push({ type: status === 'won' ? 'win' : 'death', reason, cell });
  finalizeScore(state);
  return { state, events };
}

// ---------------------------------------------------------------------------
// Serialization, hashing, replay
// ---------------------------------------------------------------------------

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function serializeState(state) {
  return JSON.stringify(state);
}

// Migration path: older documents are upgraded version by version.
export function deserializeState(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : json;
  if (!state || typeof state !== 'object') throw new Error('invalid state document');
  if (state.version > RULES_VERSION) throw new Error('state from a newer rules version');
  // version 1 is current; future migrations chain here.
  return state;
}

export function hashState(state) {
  return hashString(canonicalJson(state));
}

// Deterministic replay: same version + seed + commands => identical hashes.
// commands: [{ tick, id?, type:'turn', dir }] applied before the matching tick advances.
export function runReplay(config, commands) {
  let state = createGame(config);
  const sorted = [...commands].sort((a, b) => a.tick - b.tick);
  const seenIds = new Set();
  const hashes = [];
  let ci = 0;
  const maxTicks = state.config.maxTicks > 0 ? state.config.maxTicks + 1 : 100000;
  while (state.status === 'active' && state.tick <= maxTicks) {
    while (ci < sorted.length && sorted[ci].tick <= state.tick + 1) {
      const cmd = sorted[ci++];
      if (cmd.id) {
        if (seenIds.has(cmd.id)) continue; // idempotent duplicate rejection
        seenIds.add(cmd.id);
      }
      const res = applyCommand(state, cmd);
      state = res.state;
    }
    const res = advanceTick(state);
    state = res.state;
    if (state.tick % 50 === 0 || state.status !== 'active') hashes.push({ tick: state.tick, hash: hashState(state) });
    if (ci >= sorted.length && state.status !== 'active') break;
  }
  return { finalHash: hashState(state), state, hashes };
}
