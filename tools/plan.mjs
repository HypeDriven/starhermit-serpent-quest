// A rules bot for play scripts: plays a round with the real rules (js/rules.js)
// and the session's fixed-step clock (js/session.js advance, 1000/60 ms a
// step), choosing each tick's turn by one-tick lookahead (the real
// advanceTick, rivals included) toward the round's target (food, or a small
// rival for rival goals) with a flood-fill escape check. Returns the turns
// with the fixed step each must reach the session on, counted from the step
// the countdown ended ("Go!"), and the final state, so tools/gen-plays.mjs
// can emit exact key / touch timings and `expect` lines.
import { createGame, advanceTick, applyCommand, getLegalActions, cellKey } from '../js/rules.js';

const STEP = 1000 / 60;
const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** The step of each tick (1-based ticks) after the "Go!" step, as session.advance runs them. */
export function tickSteps(tickMs, count) {
  const out = [0];
  let acc = 0, step = 0;
  while (out.length <= count) {
    step++;
    acc += STEP;
    let n = 0;
    while (acc >= tickMs - 1e-6 && n < 8) { acc = Math.max(0, acc - tickMs); out.push(step); n++; }
  }
  return out;
}

function blocked(state) {
  const occ = new Set();
  for (const c of state.obstacles) occ.add(cellKey(c));
  const body = state.snake.body;
  for (let i = 0; i < body.length - 1; i++) occ.add(cellKey(body[i]));
  for (const r of state.rivals) if (r.alive) for (const c of r.body) occ.add(cellKey(c));
  for (const r of state.rivals) if (r.alive && r.tier === 'big') {
    const h = r.body[0];
    for (const [dx, dy] of Object.values(D)) occ.add(cellKey({ x: h.x + dx, y: h.y + dy }));
  }
  return occ;
}
function inside(s, c) { return c.x >= 0 && c.y >= 0 && c.x < s.grid.w && c.y < s.grid.h; }
/** BFS distances from the head over free cells. */
function bfs(s, from, occ) {
  const dist = new Map([[cellKey(from), 0]]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    const d = dist.get(cellKey(c));
    for (const [dx, dy] of Object.values(D)) {
      const n = { x: c.x + dx, y: c.y + dy };
      const k = cellKey(n);
      if (!inside(s, n) || occ.has(k) || dist.has(k)) continue;
      dist.set(k, d + 1);
      q.push(n);
    }
  }
  return dist;
}
function targets(s) {
  const goals = s.goals.filter((g) => !g.done);
  const wantRivals = goals.some((g) => g.kind === 'rivals');
  const prey = s.rivals.filter((r) => r.alive && r.tier === 'small').flatMap((r) => r.body);
  if (wantRivals && prey.length) return prey;
  return s.food;
}
function evaluate(next) {
  if (next.status === 'won') return 1e9;
  if (next.status !== 'active') return -1e9;
  const head = next.snake.body[0];
  const occ = blocked(next);
  occ.delete(cellKey(head));
  const dist = bfs(next, head, occ);
  const room = dist.size;
  let best = 999;
  for (const t of targets(next)) { const d = dist.get(cellKey(t)); if (d != null && d < best) best = d; }
  // progress (food, rivals, growth) outweighs distance, or the bot circles a berry it would eat
  let score = -best * 10 + (next.stats.foodEaten + next.stats.rivalsDefeated * 3) * 1000;
  if (room < next.snake.body.length + 4) score -= 5000 - room * 10;
  // keep off the walls a little (more room to turn)
  const edge = Math.min(head.x, head.y, next.grid.w - 1 - head.x, next.grid.h - 1 - head.y);
  if (edge === 0) score -= 3;
  return score;
}

/**
 * Plays a round. `opts.maxTicks` bounds it, `opts.stopAfterTurns` ends it once that many turns were made
 * (lessons), `opts.dieAt` lets a round be lost on purpose (it stops steering from that tick).
 * Returns { turns: [{ tick, dir, step }], state }: `tick` is the tick the turn applies on.
 */
export function plan(config, opts = {}) {
  let s = createGame(config);
  const turns = [];
  const steps = tickSteps(Math.max(60, Math.round(config.tickMs * (opts.tickScale || 1))), (opts.maxTicks || 3000) + 2);
  const cap = opts.maxTicks || 3000;
  while (s.status === 'active' && s.tick < cap) {
    let bestDir = null, bestScore = -Infinity;
    if (!(opts.dieAt != null && s.tick >= opts.dieAt)) {
      for (const a of getLegalActions(s)) {
        const t = a.dir === s.snake.dir ? s : applyCommand(s, { type: 'turn', dir: a.dir }).state;
        let v = evaluate(advanceTick(t).state);
        if (a.dir === s.snake.dir) v += 0.5; // prefer fewer turns on ties
        if (v > bestScore) { bestScore = v; bestDir = a.dir; }
      }
    }
    if (bestDir && bestDir !== s.snake.dir) {
      s = applyCommand(s, { type: 'turn', dir: bestDir }).state;
      turns.push({ tick: s.tick + 1, dir: bestDir, step: Math.round((steps[s.tick] + steps[s.tick + 1]) / 2) });
      // the steering lesson ends on its last turn (main.ts noteLessonAction abandons the round there)
      if (opts.stopAfterTurns && turns.length >= opts.stopAfterTurns) { s = { ...s, status: 'lost', terminalReason: 'abandoned' }; break; }
    }
    s = advanceTick(s).state;
  }
  return { turns, state: s, steps };
}
