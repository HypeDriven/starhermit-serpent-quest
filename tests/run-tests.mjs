// Rules + content test suite. Run: node tests/run-tests.mjs
import {
  createGame, getLegalActions, applyCommand, advanceTick, serializeState,
  deserializeState, hashState, runReplay, getSafeTurns, RULES_VERSION,
} from '../js/rules.js';
import {
  JOURNEY_STAGES, CHALLENGES, TUTORIALS, THEMES, dailyConfig, practiceConfig,
  validateAllContent, toRulesConfig, PRACTICE_DIFFICULTIES, contentHash,
} from '../js/content.js';
import { hashString, seedFromString } from '../js/rng.js';
import { validateScoreClaim } from '../server.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; failures.push(name + ': ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'eq'} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

function baseConfig(over = {}) {
  return {
    seed: 12345, grid: { w: 12, h: 12 },
    start: { x: 6, y: 6, dir: 'up', length: 3 },
    food: { count: 2, goldenChance: 0 },
    rivals: [], obstacles: [], goals: [{ kind: 'food', count: 3 }],
    tickMs: 140, parTicks: 200, maxTicks: 0, moveLimit: 0, mechanics: {}, ...over,
  };
}
function step(state, n = 1) {
  let s = state;
  for (let i = 0; i < n; i++) s = advanceTick(s).state;
  return s;
}
function turn(state, dir) {
  const r = applyCommand(state, { id: 't', type: 'turn', dir });
  if (r.error) throw new Error('turn rejected: ' + r.error.reason);
  return r.state;
}

// --- Legal actions ---------------------------------------------------------

test('initial legal actions exclude only the reverse', () => {
  const s = createGame(baseConfig());
  const dirs = getLegalActions(s).map((a) => a.dir).sort();
  eq(dirs, ['left', 'right', 'up']); // facing up: down is reverse
});

test('turn commands update legal actions', () => {
  let s = createGame(baseConfig());
  s = turn(s, 'left');
  s = step(s);
  const dirs = getLegalActions(s).map((a) => a.dir).sort();
  eq(dirs, ['down', 'left', 'up']); // facing left: right is reverse
});

test('terminal state has no legal actions', () => {
  let s = createGame(baseConfig({ start: { x: 0, y: 0, dir: 'left', length: 3 } }));
  s = step(s);
  eq(s.status, 'lost');
  eq(getLegalActions(s), []);
});

// --- Invalid action reasons -------------------------------------------------

test('reverse is rejected with reason and counts invalid', () => {
  const s = createGame(baseConfig());
  const r = applyCommand(s, { id: 'x', type: 'turn', dir: 'down' });
  ok(r.error, 'expected error');
  eq(r.error.code, 'reverse');
  eq(r.state.stats.invalidActions, 1);
  eq(s.stats.invalidActions, 0, 'original state untouched');
});

test('malformed and unknown commands are rejected without mutation', () => {
  const s = createGame(baseConfig());
  ok(applyCommand(s, null).error.code === 'malformed');
  ok(applyCommand(s, { type: 'teleport', x: 0 }).error.code === 'unknown-command');
  ok(applyCommand(s, { type: 'turn', dir: 'northeast' }).error.code === 'bad-direction');
  eq(applyCommand(s, null).state, s);
});

test('commands after game over are rejected', () => {
  let s = createGame(baseConfig({ start: { x: 0, y: 0, dir: 'left', length: 3 } }));
  s = step(s);
  const r = applyCommand(s, { type: 'turn', dir: 'up' });
  eq(r.error.code, 'game-over');
});

// --- Movement, eating, growth ----------------------------------------------

test('serpent moves one cell per tick and keeps length', () => {
  let s = createGame(baseConfig());
  const before = { ...s.snake.body[0] };
  s = step(s);
  eq(s.snake.body[0], { x: before.x, y: before.y - 1 });
  eq(s.snake.body.length, 3);
  eq(s.tick, 1);
});

test('eating food adds score and grows on the following ticks', () => {
  // Place food directly ahead: seed-specific spawns make fixed configs easier.
  const cfg = baseConfig({ food: { count: 0, goldenChance: 0 } });
  let s = createGame(cfg);
  s.food.push({ x: 6, y: 5, kind: 'berry' }); // directly ahead of head (6,6)->(6,5)
  const scoreBefore = s.score.food;
  s = step(s);
  eq(s.score.food, scoreBefore + 10);
  eq(s.stats.foodEaten, 1);
  eq(s.snake.growPending, 1);
  s = step(s);
  eq(s.snake.body.length, 4, 'grew by one');
  ok(s.score.growth > 0);
});

test('golden food is worth more and grows two', () => {
  const cfg = baseConfig({ food: { count: 0, goldenChance: 0 } });
  let s = createGame(cfg);
  s.food.push({ x: 6, y: 5, kind: 'golden' });
  s = step(s);
  eq(s.score.food, 50);
  eq(s.snake.growPending, 2);
});

// --- Terminal states --------------------------------------------------------

test('wall crash is terminal with reason', () => {
  let s = createGame(baseConfig({ start: { x: 0, y: 0, dir: 'left', length: 3 } }));
  s = step(s);
  eq(s.status, 'lost');
  eq(s.terminalReason, 'crashed-wall');
});

test('obstacle crash is terminal with reason', () => {
  let s = createGame(baseConfig({ obstacles: [{ x: 6, y: 3 }] }));
  s = step(s, 3);
  eq(s.terminalReason, 'crashed-obstacle');
});

test('self crash is detected', () => {
  // Grow long, then turn into own body.
  const cfg = baseConfig({ food: { count: 0, goldenChance: 0 } });
  let s = createGame(cfg);
  s.snake.growPending = 6;
  s = step(s, 2); // length 5 heading up
  s = turn(s, 'left'); s = step(s);
  s = turn(s, 'down'); s = step(s);
  s = turn(s, 'right'); s = step(s);
  eq(s.terminalReason, 'crashed-self');
  eq(s.status, 'lost');
});

// Steer in a safe square so limits (not walls) end these runs.
function stepCircling(state, n) {
  let s = state;
  for (let i = 0; i < n && s.status === 'active'; i++) {
    const head = s.snake.body[0];
    const d = s.snake.dir;
    const ahead = {
      x: head.x + (d === 'right' ? 1 : d === 'left' ? -1 : 0),
      y: head.y + (d === 'down' ? 1 : d === 'up' ? -1 : 0),
    };
    if (ahead.x < 1 || ahead.y < 1 || ahead.x >= s.grid.w - 1 || ahead.y >= s.grid.h - 1) {
      const right = { up: 'right', right: 'down', down: 'left', left: 'up' }[s.snake.dir];
      s = turn(s, right);
    }
    s = step(s);
  }
  return s;
}

// Like stepCircling but issues one command every tick, so the count of player
// moves (state.stats.commands) equals the number of steps taken.
function stepCirclingWithMoves(state, n) {
  let s = state;
  for (let i = 0; i < n && s.status === 'active'; i++) {
    const head = s.snake.body[0];
    const d = s.snake.dir;
    const ahead = {
      x: head.x + (d === 'right' ? 1 : d === 'left' ? -1 : 0),
      y: head.y + (d === 'down' ? 1 : d === 'up' ? -1 : 0),
    };
    let cmd = d;
    if (ahead.x < 1 || ahead.y < 1 || ahead.x >= s.grid.w - 1 || ahead.y >= s.grid.h - 1) {
      cmd = { up: 'right', right: 'down', down: 'left', left: 'up' }[s.snake.dir];
    }
    s = turn(s, cmd);
    s = step(s);
  }
  return s;
}

test('move limit ends the run after that many player moves', () => {
  let s = createGame(baseConfig({ moveLimit: 10, goals: [{ kind: 'food', count: 99 }] }));
  s = stepCirclingWithMoves(s, 10);
  eq(s.terminalReason, 'moves-exhausted');
});

test('time cap ends the run', () => {
  let s = createGame(baseConfig({ maxTicks: 8, goals: [{ kind: 'food', count: 99 }] }));
  s = stepCircling(s, 8);
  eq(s.terminalReason, 'time-up');
});

test('completing all goals wins with objective bonus', () => {
  const cfg = baseConfig({ food: { count: 0, goldenChance: 0 }, goals: [{ kind: 'food', count: 1 }] });
  let s = createGame(cfg);
  s.food.push({ x: 6, y: 5, kind: 'berry' });
  s = step(s);
  eq(s.status, 'won');
  eq(s.terminalReason, 'objective-complete');
  ok(s.score.objective >= 250);
  ok(s.score.total === s.score.food + s.score.growth + s.score.rivals + s.score.survival + s.score.objective);
});

test('big rival contact is fatal; small rival is prey', () => {
  const cfg = baseConfig({
    food: { count: 0, goldenChance: 0 },
    rivals: [{ tier: 'big', length: 3, x: 6, y: 3 }],
  });
  let s = createGame(cfg);
  s = step(s, 3); // head reaches (6,3)
  eq(s.terminalReason, 'eaten-by-rival');

  const cfg2 = baseConfig({
    food: { count: 0, goldenChance: 0 },
    rivals: [{ tier: 'small', length: 2, x: 6, y: 3 }],
  });
  let s2 = createGame(cfg2);
  s2 = step(s2, 3);
  eq(s2.stats.rivalsDefeated, 1);
  eq(s2.score.rivals, 100);
  ok(s2.snake.alive);
});

// --- Determinism, serialization, replay -------------------------------------

test('serialization round-trips and hashes are stable', () => {
  let s = createGame(baseConfig({ rivals: [{ tier: 'small', length: 2 }] }));
  s = step(s, 25);
  const h1 = hashState(s);
  const restored = deserializeState(serializeState(s));
  eq(hashState(restored), h1);
  eq(restored.version, RULES_VERSION);
});

test('same seed + same commands replay to identical hashes', () => {
  const cfg = baseConfig({ rivals: [{ tier: 'small', length: 2 }, { tier: 'big', length: 4 }] });
  const commands = [
    { tick: 2, id: 'a', type: 'turn', dir: 'left' },
    { tick: 8, id: 'b', type: 'turn', dir: 'down' },
    { tick: 12, id: 'c', type: 'turn', dir: 'right' },
  ];
  const r1 = runReplay(cfg, commands);
  const r2 = runReplay(cfg, commands);
  eq(r1.finalHash, r2.finalHash);
  eq(r1.hashes, r2.hashes);
});

test('duplicate command ids are rejected idempotently in replay', () => {
  const cfg = baseConfig();
  const commands = [
    { tick: 2, id: 'dup', type: 'turn', dir: 'left' },
    { tick: 2, id: 'dup', type: 'turn', dir: 'right' }, // ignored
  ];
  const r1 = runReplay(cfg, commands);
  const r2 = runReplay(cfg, [{ tick: 2, id: 'dup', type: 'turn', dir: 'left' }]);
  eq(r1.finalHash, r2.finalHash);
});

test('different seeds produce different games', () => {
  const a = runReplay(baseConfig({ seed: 1 }), []);
  const b = runReplay(baseConfig({ seed: 2 }), []);
  ok(a.finalHash !== b.finalHash);
});

test('fuzz: malformed commands never throw or hang', () => {
  let s = createGame(baseConfig());
  const junk = [null, undefined, 42, 'turn', {}, { type: null }, { type: 'turn' },
    { type: 'turn', dir: 7 }, { type: 'turn', dir: { x: 1 } }, [], { type: 'turn', dir: '' }];
  for (let round = 0; round < 30; round++) {
    for (const cmd of junk) {
      const r = applyCommand(s, cmd);
      s = r.state;
    }
    s = step(s);
    ok(Number.isFinite(s.snake.body[0].x), 'no NaN positions');
  }
});

test('no unbounded loop: passive serpent always terminates', () => {
  for (const seed of [1, 7, 99, 20260]) {
    const r = runReplay(baseConfig({ seed, goals: [{ kind: 'score', count: 999999 }] }), []);
    ok(r.state.status !== 'active', 'terminated');
  }
});

// --- Hints use the same legal-action API ------------------------------------

test('safe turns are a subset of legal actions', () => {
  let s = createGame(baseConfig({ obstacles: [{ x: 6, y: 4 }] }));
  s = step(s);
  const legal = new Set(getLegalActions(s).map((a) => a.dir));
  for (const a of getSafeTurns(s)) ok(legal.has(a.dir), 'safe turn must be legal');
});

// --- Content ----------------------------------------------------------------

test('all content passes offline validators', () => {
  const report = validateAllContent();
  const bad = report.filter((r) => r.problems.length > 0);
  if (bad.length) throw new Error(bad.map((b) => b.id + ': ' + b.problems.join('; ')).join(' | '));
});

test('content volumes meet launch scope', () => {
  ok(JOURNEY_STAGES.length >= 40, 'at least 40 journey stages');
  eq(THEMES.length, 5, 'five visual themes');
  ok(TUTORIALS.length >= 5, 'tutorial sequence');
  ok(CHALLENGES.length >= 5, 'challenge set');
  eq(PRACTICE_DIFFICULTIES.length, 4);
});

test('daily config is stable per UTC day and differs across days', () => {
  const d1 = dailyConfig(new Date(Date.UTC(2026, 5, 10, 3)));
  const d2 = dailyConfig(new Date(Date.UTC(2026, 5, 10, 23)));
  const d3 = dailyConfig(new Date(Date.UTC(2026, 5, 11)));
  eq(d1.seed, d2.seed, 'same UTC day, same seed');
  ok(d1.seed !== d3.seed, 'next day differs');
  eq(d1.day, '2026-06-10');
});

test('server score validation rejects malformed days without throwing', () => {
  for (const day of ['garbage', '2026-13-99', '2026/01/01', '', 42, null]) {
    const r = validateScoreClaim({
      contentVersion: 1, rulesetId: 'daily-v1', day, seed: 1, inputLog: [],
    });
    ok(!r.ok, 'rejected: ' + JSON.stringify(day));
    eq(r.error, 'day-excluded');
  }
});

test('server score validation reaches seed check for a real day', () => {
  const day = '2026-01-05';
  const r = validateScoreClaim({
    contentVersion: 1, rulesetId: 'daily-v1', day, seed: 1, inputLog: [],
  });
  eq(r.error, 'seed-mismatch'); // valid day, wrong seed
});

test('journey stages instantiate and simulate without errors', () => {
  for (const st of JOURNEY_STAGES) {
    const cfg = toRulesConfig(st);
    const r = runReplay(cfg, []);
    ok(Number.isFinite(r.state.score.total), st.id + ' finite score');
    ok(r.state.tick > 0, st.id + ' advanced');
  }
});

// --- Golden sessions ---------------------------------------------------------
// Representative scripted sessions with pinned outcomes. If these change, the
// rules or content changed in a user-visible way.

test('golden: easy stage 1 is winnable by a scripted path', () => {
  const st = JOURNEY_STAGES[0];
  const cfg = toRulesConfig(st);
  // Greedy food-seeking script using only the public API.
  let s = createGame(cfg);
  let commands = [];
  for (let t = 0; t < 600 && s.status === 'active'; t++) {
    const head = s.snake.body[0];
    const food = s.food[0];
    if (!food) break;
    const legal = getLegalActions(s).map((a) => a.dir);
    const safe = getSafeTurns(s).map((a) => a.dir);
    const want = Math.abs(food.x - head.x) > Math.abs(food.y - head.y)
      ? (food.x > head.x ? 'right' : 'left')
      : (food.y > head.y ? 'down' : 'up');
    const alt = Math.abs(food.x - head.x) > Math.abs(food.y - head.y)
      ? (food.y > head.y ? 'down' : 'up')
      : (food.x > head.x ? 'right' : 'left');
    const pickDir = [want, alt, ...safe, ...legal].find((d) => legal.includes(d) && safe.includes(d)) || legal[0];
    if (pickDir && pickDir !== s.snake.dir) {
      commands.push({ tick: s.tick + 1, id: 'g' + t, type: 'turn', dir: pickDir });
      s = turn(s, pickDir); // apply the same command to the scripted run
    }
    s = step(s);
  }
  eq(s.status, 'won', 'greedy script should clear stage 1');
  eq(s.terminalReason, 'objective-complete');
  const replayed = runReplay(cfg, commands);
  eq(hashState(replayed.state), hashState(s), 'golden session replays exactly');
});

test('golden hashes: pinned deterministic outcomes', () => {
  const cfg = toRulesConfig(JOURNEY_STAGES[3]);
  const r = runReplay(cfg, [
    { tick: 3, id: 'p1', type: 'turn', dir: 'right' },
    { tick: 10, id: 'p2', type: 'turn', dir: 'down' },
  ]);
  eq(r.finalHash, GOLDEN.stage4, 'stage 4 golden hash');
  const d = dailyConfig(new Date(Date.UTC(2026, 0, 5)));
  const rd = runReplay(toRulesConfig(d), []);
  eq(rd.finalHash, GOLDEN.daily, 'daily golden hash');
  eq(contentHash(), GOLDEN.content, 'content fingerprint');
});

// Golden values are filled by tests/record-golden.mjs and must only change
// deliberately, with a review of the rules/content diff that caused it.
import { GOLDEN } from './golden.mjs';

// --- Report ------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
