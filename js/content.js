// Versioned content: themes, tutorials, journey stages, challenges, daily seed,
// and offline validators (legality, reachability, bounded duration, no soft locks).

import { createRng, nextInt, seedFromString, hashString } from './rng.js';
import { createGame, serializeState, hashState } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Themes — five original visual identities. Colors are presentation-only;
// they never alter rules, hitboxes, timing, or information.
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    id: 'meadow', name: 'Morning Meadow',
    sky: 0xbfe3ff, fog: 0xcfe8d8, sun: 0xfff2d8, sunIntensity: 2.2,
    ground: 0x6fae4e, groundDark: 0x598c3e,
    grass: [0x7cc24f, 0x5da83c, 0x93d060],
    flowers: [0xff7fa5, 0xffd166, 0xffffff, 0xb388ff],
    hedge: 0x3e7a33, rock: 0x9a9f8f, water: 0x7cc4de,
    snakeHead: 0x2f8f4e, snakeBody: 0x46b364, snakeBelly: 0xcdeeb0,
    rivalSmall: 0xd9903b, rivalBig: 0x8a4a2b,
    food: 0xe33f5e, foodGolden: 0xffc93c,
    ambience: 'birds',
  },
  {
    id: 'orchard', name: 'Sunset Orchard',
    sky: 0xffc98a, fog: 0xf2b48a, sun: 0xffb36b, sunIntensity: 2.0,
    ground: 0x8fa348, groundDark: 0x74883a,
    grass: [0xa7b74e, 0x8ba03e, 0xc0c964],
    flowers: [0xff8c69, 0xffe08a, 0xe06a9a, 0xfff4d6],
    hedge: 0x5c6e2e, rock: 0xa89a83, water: 0xd9a06b,
    snakeHead: 0x38755a, snakeBody: 0x4f9a74, snakeBelly: 0xf0e6b8,
    rivalSmall: 0xc96f2f, rivalBig: 0x7a3b22,
    food: 0xd63a3a, foodGolden: 0xffd23c,
    ambience: 'crickets',
  },
  {
    id: 'moonpond', name: 'Moonlit Pond',
    sky: 0x1c2a4a, fog: 0x223354, sun: 0xbcd0ff, sunIntensity: 1.1,
    ground: 0x2f5d4a, groundDark: 0x254a3c,
    grass: [0x3d7a5c, 0x2f6549, 0x4f9570],
    flowers: [0x9ad6ff, 0xd8b4ff, 0x7fffd4, 0xf0f0ff],
    hedge: 0x1f4436, rock: 0x5f6f7a, water: 0x2e5f8a,
    snakeHead: 0x3fae8f, snakeBody: 0x57c9a6, snakeBelly: 0xd6f5e3,
    rivalSmall: 0xd9b23b, rivalBig: 0x9a5a8a,
    food: 0xff6f91, foodGolden: 0xffe95c,
    ambience: 'night',
  },
  {
    id: 'hollow', name: 'Autumn Hollow',
    sky: 0xe8d8b0, fog: 0xdcc9a0, sun: 0xffe4b0, sunIntensity: 1.8,
    ground: 0xa07840, groundDark: 0x86652f,
    grass: [0xb98a3e, 0xa07432, 0xd0a050],
    flowers: [0xd65a3a, 0xffb03a, 0x8a5a9a, 0xf5e6c8],
    hedge: 0x6e4f24, rock: 0x8f8578, water: 0x9a8468,
    snakeHead: 0x4a7a3a, snakeBody: 0x5f9648, snakeBelly: 0xe8e0b0,
    rivalSmall: 0xb05a2a, rivalBig: 0x6e3220,
    food: 0xc23a4a, foodGolden: 0xffcf3c,
    ambience: 'wind',
  },
  {
    id: 'dunes', name: 'Coral Dunes',
    sky: 0xbfe8e0, fog: 0xd8efe0, sun: 0xfff8e0, sunIntensity: 2.4,
    ground: 0xe0c88f, groundDark: 0xc9b078,
    grass: [0x7fae6a, 0x699858, 0x98c47e],
    flowers: [0xff7f7f, 0xffd1dc, 0x7fd4c1, 0xfff0b8],
    hedge: 0x4a8a6a, rock: 0xc4a58f, water: 0x5fc4c9,
    snakeHead: 0x2f7a8f, snakeBody: 0x4198ad, snakeBelly: 0xd0f0e8,
    rivalSmall: 0xe08a3c, rivalBig: 0xa04a5a,
    food: 0xe84a6f, foodGolden: 0xffd23c,
    ambience: 'shore',
  },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// ---------------------------------------------------------------------------
// Obstacle patterns — materialized deterministically from the content seed.
// ---------------------------------------------------------------------------

export function materializeObstacles(pattern, grid, seed, density = 1) {
  const rng = createRng(seedFromString('obstacles:' + pattern + ':' + seed));
  const cells = [];
  const cx = Math.floor(grid.w / 2);
  const cy = Math.floor(grid.h / 2);
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return;
    if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return; // keep spawn clear
    cells.push({ x, y });
  };
  switch (pattern) {
    case 'none': break;
    case 'pillars': {
      const n = 2 + Math.floor(density * 2);
      for (let i = 0; i < n; i++) {
        const x = 2 + nextInt(rng, grid.w - 4);
        const y = 2 + nextInt(rng, grid.h - 4);
        push(x, y); push(x + 1, y); push(x, y + 1); push(x + 1, y + 1);
      }
      break;
    }
    case 'ring': {
      const rx = Math.floor(grid.w / 4);
      const ry = Math.floor(grid.h / 4);
      for (let x = cx - rx; x <= cx + rx; x++) { push(x, cy - ry); push(x, cy + ry); }
      for (let y = cy - ry; y <= cy + ry; y++) { push(cx - rx, y); push(cx + rx, y); }
      // knock out every seventh cell to create gates
      cells.splice(0, cells.length, ...cells.filter((c, i) => i % 7 !== 3));
      break;
    }
    case 'cross': {
      for (let x = 2; x < grid.w - 2; x++) if (x % 4 !== 0) push(x, cy);
      for (let y = 2; y < grid.h - 2; y++) if (y % 4 !== 1) push(cx, y);
      break;
    }
    case 'lanes': {
      for (let y = 2; y < grid.h - 2; y += 4) {
        for (let x = 1; x < grid.w - 1; x++) if (x % 5 !== 2) push(x, y);
      }
      break;
    }
    case 'scattered': {
      const n = Math.floor(grid.w * grid.h * 0.04 * density);
      for (let i = 0; i < n; i++) push(nextInt(rng, grid.w), nextInt(rng, grid.h));
      break;
    }
  }
  // dedupe
  const seen = new Set();
  return cells.filter((c) => {
    const k = c.x + ',' + c.y;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Journey — 42 authored stages. One new concept in isolation, combined with a
// known concept, then a mastery stage before the next concept.
// ---------------------------------------------------------------------------

function stage(n, opts) {
  const id = 'j' + String(n).padStart(2, '0');
  return {
    id,
    index: n,
    name: opts.name,
    kind: opts.mastery ? 'mastery' : 'stage',
    teaches: opts.teaches || null,
    seed: seedFromString('journey:' + id),
    grid: opts.grid || { w: 16, h: 16 },
    start: opts.start || { x: Math.floor((opts.grid ? opts.grid.w : 16) / 2), y: Math.floor((opts.grid ? opts.grid.h : 16) / 2), dir: 'up', length: 3 },
    food: { count: opts.foodCount ?? 3, goldenChance: opts.goldenChance ?? 0.08 },
    rivals: opts.rivals || [],
    obstaclePattern: opts.obstacles || 'none',
    obstacleDensity: opts.obstacleDensity ?? 1,
    goals: opts.goals,
    tickMs: opts.tickMs ?? 140,
    parTicks: opts.parTicks ?? 300,
    maxTicks: opts.maxTicks ?? 0,
    moveLimit: opts.moveLimit ?? 0,
    mechanics: { allowUndo: false, rivalsEatFood: true, ...(opts.mechanics || {}) },
    themeId: opts.theme || THEMES[n % THEMES.length].id,
  };
}

const G = {
  food: (count) => [{ kind: 'food', count }],
  length: (count) => [{ kind: 'length', count }],
  rivals: (count) => [{ kind: 'rivals', count }],
  survive: (ticks) => [{ kind: 'survive', count: ticks }],
  score: (points) => [{ kind: 'score', count: points }],
  combo: (...goals) => goals.flat(),
};

export const JOURNEY_STAGES = [
  // --- Chapter 1: steering and eating (concept: food) ---
  stage(1, { name: 'First Slither', teaches: 'steer', goals: G.food(4), parTicks: 120, theme: 'meadow' }),
  stage(2, { name: 'Berry Trail', goals: G.food(7), parTicks: 170, theme: 'meadow' }),
  stage(3, { name: 'Long Way Round', obstacles: 'pillars', goals: G.food(8), parTicks: 220, theme: 'meadow' }),
  stage(4, { name: 'Mastery: The Open Field', mastery: true, grid: { w: 18, h: 18 }, goals: G.food(12), parTicks: 260, theme: 'meadow' }),
  // --- Chapter 2: length and self-collision (concept: length) ---
  stage(5, { name: 'Growing Pains', teaches: 'length', goals: G.length(8), parTicks: 200, theme: 'orchard' }),
  stage(6, { name: 'Coiled Garden', obstacles: 'cross', goals: G.length(10), parTicks: 280, theme: 'orchard' }),
  stage(7, { name: 'Mastery: Knotwork', mastery: true, obstacles: 'cross', grid: { w: 18, h: 18 }, goals: G.combo(G.length(12), G.food(10)), parTicks: 380, theme: 'orchard' }),
  // --- Chapter 3: small rivals as prey (concept: hunt) ---
  stage(8, { name: 'First Hunt', teaches: 'hunt', rivals: [{ tier: 'small', length: 2 }], goals: G.rivals(1), parTicks: 300, theme: 'hollow' }),
  stage(9, { name: 'Two in the Grass', rivals: [{ tier: 'small', length: 2 }, { tier: 'small', length: 3 }], goals: G.rivals(2), parTicks: 380, theme: 'hollow' }),
  stage(10, { name: 'Hunter\'s Picnic', rivals: [{ tier: 'small', length: 3 }], goals: G.combo(G.rivals(1), G.food(6)), parTicks: 380, theme: 'hollow' }),
  stage(11, { name: 'Mastery: Ambush Lanes', mastery: true, obstacles: 'lanes', rivals: [{ tier: 'small', length: 2 }, { tier: 'small', length: 2 }, { tier: 'small', length: 3 }], goals: G.rivals(3), parTicks: 500, theme: 'hollow' }),
  // --- Chapter 4: big rivals as threats (concept: threat) ---
  stage(12, { name: 'Something Bigger', teaches: 'threat', rivals: [{ tier: 'big', length: 5 }], goals: G.food(8), parTicks: 320, theme: 'moonpond' }),
  stage(13, { name: 'Keep Your Distance', rivals: [{ tier: 'big', length: 6 }], goals: G.survive(200), parTicks: 200, maxTicks: 200, theme: 'moonpond' }),
  stage(14, { name: 'Hunted Hunter', rivals: [{ tier: 'big', length: 5 }, { tier: 'small', length: 2 }], goals: G.rivals(1), parTicks: 420, theme: 'moonpond' }),
  stage(15, { name: 'Mastery: Moonlit Chase', mastery: true, grid: { w: 20, h: 20 }, rivals: [{ tier: 'big', length: 6 }, { tier: 'small', length: 2 }], goals: G.combo(G.food(10), G.survive(1)), parTicks: 500, theme: 'moonpond' }),
  // --- Chapter 5: golden food and score play (concept: score) ---
  stage(16, { name: 'Golden Hour', teaches: 'golden', goldenChance: 0.3, goals: G.score(300), parTicks: 260, theme: 'dunes' }),
  stage(17, { name: 'Risk and Reward', goldenChance: 0.25, obstacles: 'pillars', goals: G.score(450), parTicks: 340, theme: 'dunes' }),
  stage(18, { name: 'Mastery: High Roller', mastery: true, goldenChance: 0.3, obstacles: 'ring', grid: { w: 20, h: 20 }, goals: G.score(700), parTicks: 480, theme: 'dunes' }),
  // --- Chapter 6: speed (concept: speed) ---
  stage(19, { name: 'Quickened Pace', teaches: 'speed', tickMs: 110, goals: G.food(8), parTicks: 220, theme: 'meadow' }),
  stage(20, { name: 'Swift Current', tickMs: 100, obstacles: 'lanes', goals: G.food(10), parTicks: 300, theme: 'dunes' }),
  stage(21, { name: 'Mastery: Blink', mastery: true, tickMs: 95, grid: { w: 18, h: 18 }, rivals: [{ tier: 'small', length: 2 }], goals: G.combo(G.food(8), G.rivals(1)), parTicks: 380, theme: 'dunes' }),
  // --- Chapter 7: dense arenas ---
  stage(22, { name: 'Hedge Maze', obstacles: 'cross', obstacleDensity: 1.4, goals: G.food(10), parTicks: 380, theme: 'hollow' }),
  stage(23, { name: 'Ring Around', obstacles: 'ring', rivals: [{ tier: 'small', length: 3 }], goals: G.combo(G.food(8), G.rivals(1)), parTicks: 420, theme: 'hollow' }),
  stage(24, { name: 'Mastery: The Warrens', mastery: true, obstacles: 'scattered', obstacleDensity: 2, grid: { w: 22, h: 22 }, goals: G.length(14), parTicks: 520, theme: 'hollow' }),
  // --- Chapter 8: endurance ---
  stage(25, { name: 'Long Afternoon', teaches: 'endure', maxTicks: 400, goals: G.survive(400), parTicks: 400, theme: 'meadow' }),
  stage(26, { name: 'Stalemate', maxTicks: 350, rivals: [{ tier: 'big', length: 5 }], goals: G.survive(350), parTicks: 350, theme: 'moonpond' }),
  stage(27, { name: 'Mastery: Marathon', mastery: true, maxTicks: 500, grid: { w: 22, h: 22 }, obstacles: 'lanes', goals: G.combo(G.survive(500), G.food(10)), parTicks: 500, theme: 'meadow' }),
  // --- Chapter 9: combined pressure ---
  stage(28, { name: 'Crossfire', tickMs: 120, rivals: [{ tier: 'big', length: 5 }, { tier: 'small', length: 2 }, { tier: 'small', length: 2 }], goals: G.rivals(2), parTicks: 500, theme: 'orchard' }),
  stage(29, { name: 'Tight Quarters', grid: { w: 12, h: 12 }, goals: G.food(8), parTicks: 260, theme: 'orchard' }),
  stage(30, { name: 'Mastery: Crucible', mastery: true, tickMs: 115, grid: { w: 18, h: 18 }, obstacles: 'pillars', rivals: [{ tier: 'big', length: 6 }, { tier: 'small', length: 3 }], goals: G.combo(G.food(10), G.rivals(1)), parTicks: 520, theme: 'orchard' }),
  // --- Chapter 10: grand tour ---
  stage(31, { name: 'Grand Meadow', grid: { w: 24, h: 24 }, goals: G.score(600), parTicks: 500, theme: 'meadow' }),
  stage(32, { name: 'Grand Orchard', grid: { w: 24, h: 24 }, obstacles: 'lanes', goldenChance: 0.2, goals: G.score(800), parTicks: 560, theme: 'orchard' }),
  stage(33, { name: 'Grand Hollow', grid: { w: 24, h: 24 }, obstacles: 'cross', rivals: [{ tier: 'small', length: 3 }, { tier: 'small', length: 3 }], goals: G.combo(G.length(15), G.rivals(2)), parTicks: 620, theme: 'hollow' }),
  stage(34, { name: 'Grand Pond', grid: { w: 24, h: 24 }, tickMs: 115, rivals: [{ tier: 'big', length: 7 }], goals: G.score(900), parTicks: 640, theme: 'moonpond' }),
  stage(35, { name: 'Grand Dunes', grid: { w: 24, h: 24 }, obstacles: 'ring', goldenChance: 0.25, tickMs: 110, goals: G.score(1000), parTicks: 680, theme: 'dunes' }),
  stage(36, { name: 'Mastery: The Grand Tour', mastery: true, grid: { w: 24, h: 24 }, obstacles: 'lanes', tickMs: 110, goldenChance: 0.2, rivals: [{ tier: 'big', length: 6 }, { tier: 'small', length: 3 }], goals: G.combo(G.score(900), G.rivals(1)), parTicks: 700, theme: 'meadow' }),
  // --- Chapter 11: expert gauntlet ---
  stage(37, { name: 'Needle\'s Eye', grid: { w: 14, h: 14 }, obstacles: 'cross', tickMs: 110, goals: G.food(9), parTicks: 340, theme: 'moonpond' }),
  stage(38, { name: 'Feeding Frenzy', grid: { w: 20, h: 20 }, foodCount: 6, rivals: [{ tier: 'small', length: 3 }, { tier: 'small', length: 3 }, { tier: 'small', length: 2 }], goals: G.rivals(3), parTicks: 560, theme: 'dunes' }),
  stage(39, { name: 'Apex Garden', grid: { w: 20, h: 20 }, rivals: [{ tier: 'big', length: 7 }, { tier: 'big', length: 5 }], maxTicks: 450, goals: G.survive(450), parTicks: 450, theme: 'hollow' }),
  stage(40, { name: 'Serpent\'s Due', grid: { w: 22, h: 22 }, tickMs: 105, obstacles: 'pillars', goldenChance: 0.25, rivals: [{ tier: 'small', length: 3 }], goals: G.score(1100), parTicks: 720, theme: 'orchard' }),
  stage(41, { name: 'The Long Coil', grid: { w: 22, h: 22 }, tickMs: 105, obstacles: 'lanes', rivals: [{ tier: 'big', length: 6 }, { tier: 'small', length: 2 }], goals: G.combo(G.length(18), G.rivals(1)), parTicks: 760, theme: 'moonpond' }),
  stage(42, { name: 'Mastery: Serpent Quest', mastery: true, grid: { w: 24, h: 24 }, tickMs: 100, obstacles: 'ring', goldenChance: 0.25, rivals: [{ tier: 'big', length: 7 }, { tier: 'small', length: 3 }, { tier: 'small', length: 2 }], goals: G.combo(G.score(1200), G.rivals(2)), parTicks: 800, theme: 'meadow' }),
];

export function stageById(id) {
  return JOURNEY_STAGES.find((s) => s.id === id) || null;
}

// ---------------------------------------------------------------------------
// Tutorials (Learn mode) — each lesson requires the player to perform the rule.
// ---------------------------------------------------------------------------

export const TUTORIALS = [
  {
    id: 'tut-steer', name: 'Lesson 1: Steering',
    text: 'Steer the serpent. Use arrow keys, WASD, swipe, or tap a tile to choose a direction.',
    require: { action: 'turn', count: 3 },
    config: { grid: { w: 14, h: 14 }, food: { count: 0, goldenChance: 0 }, goals: [{ kind: 'survive', count: 99999 }], tickMs: 220 },
  },
  {
    id: 'tut-eat', name: 'Lesson 2: Eating & Growing',
    text: 'Eat 3 berries. Every berry makes you longer and adds to your score.',
    require: { event: 'eat', count: 3 },
    config: { grid: { w: 14, h: 14 }, food: { count: 3, goldenChance: 0 }, goals: [{ kind: 'food', count: 3 }], tickMs: 200 },
  },
  {
    id: 'tut-crash', name: 'Lesson 3: Danger',
    text: 'Walls, stones, and your own body are lethal. Survive 40 ticks while growing to length 6.',
    require: { goal: true },
    config: { grid: { w: 14, h: 14 }, obstacles: 'pillars', food: { count: 3, goldenChance: 0 }, goals: [{ kind: 'length', count: 6 }, { kind: 'survive', count: 40 }], tickMs: 190 },
  },
  {
    id: 'tut-hunt', name: 'Lesson 4: Hunting Rivals',
    text: 'Small golden rivals are prey. Catch one with your head to defeat it.',
    require: { event: 'rival-defeated', count: 1 },
    config: { grid: { w: 16, h: 16 }, food: { count: 2, goldenChance: 0 }, rivals: [{ tier: 'small', length: 2 }], goals: [{ kind: 'rivals', count: 1 }], tickMs: 190 },
  },
  {
    id: 'tut-threat', name: 'Lesson 5: Bigger Threats',
    text: 'Large dark rivals hunt YOU. Any touch is fatal. Survive 60 ticks.',
    require: { goal: true },
    config: { grid: { w: 16, h: 16 }, food: { count: 2, goldenChance: 0 }, rivals: [{ tier: 'big', length: 5 }], goals: [{ kind: 'survive', count: 60 }], maxTicks: 60, tickMs: 190 },
  },
];

// ---------------------------------------------------------------------------
// Challenges — constrained goals.
// ---------------------------------------------------------------------------

export const CHALLENGES = [
  {
    id: 'ch-moves', name: 'Counted Steps', desc: 'Finish 8 berries within 90 moves.',
    seed: seedFromString('challenge:moves'), grid: { w: 16, h: 16 },
    food: { count: 3, goldenChance: 0 }, goals: [{ kind: 'food', count: 8 }],
    moveLimit: 90, tickMs: 150, parTicks: 90, obstacles: 'none', rivals: [], themeId: 'meadow',
  },
  {
    id: 'ch-speed', name: 'Tailwind', desc: 'High speed: eat 10 berries.',
    seed: seedFromString('challenge:speed'), grid: { w: 18, h: 18 },
    food: { count: 3, goldenChance: 0.1 }, goals: [{ kind: 'food', count: 10 }],
    tickMs: 85, parTicks: 260, obstacles: 'none', rivals: [], themeId: 'dunes',
  },
  {
    id: 'ch-hedgemaze', name: 'Hedgemaze', desc: 'A dense garden cross. Reach length 12.',
    seed: seedFromString('challenge:maze'), grid: { w: 18, h: 18 },
    food: { count: 3, goldenChance: 0.05 }, goals: [{ kind: 'length', count: 12 }],
    tickMs: 140, parTicks: 420, obstacles: 'cross', obstacleDensity: 1.3, rivals: [], themeId: 'hollow',
  },
  {
    id: 'ch-rivalrush', name: 'Rival Rush', desc: 'Defeat 4 small rivals while a big one prowls.',
    seed: seedFromString('challenge:rush'), grid: { w: 20, h: 20 },
    food: { count: 2, goldenChance: 0 }, goals: [{ kind: 'rivals', count: 4 }],
    tickMs: 130, parTicks: 600, obstacles: 'none',
    rivals: [{ tier: 'small', length: 2 }, { tier: 'small', length: 2 }, { tier: 'small', length: 3 }, { tier: 'small', length: 3 }, { tier: 'big', length: 5 }],
    themeId: 'moonpond',
  },
  {
    id: 'ch-golden', name: 'Golden Only', desc: 'Score 400 with golden berries everywhere.',
    seed: seedFromString('challenge:golden'), grid: { w: 16, h: 16 },
    food: { count: 4, goldenChance: 0.6 }, goals: [{ kind: 'score', count: 400 }],
    tickMs: 130, parTicks: 320, obstacles: 'pillars', rivals: [], themeId: 'orchard',
  },
  {
    id: 'ch-gauntlet', name: 'The Gauntlet', desc: 'Survive 300 ticks with two hunters.',
    seed: seedFromString('challenge:gauntlet'), grid: { w: 22, h: 22 },
    food: { count: 2, goldenChance: 0.05 }, goals: [{ kind: 'survive', count: 300 }],
    maxTicks: 300, tickMs: 120, parTicks: 300, obstacles: 'lanes',
    rivals: [{ tier: 'big', length: 6 }, { tier: 'big', length: 5 }], themeId: 'hollow',
  },
];

// ---------------------------------------------------------------------------
// Daily — one shared seed + ruleset per UTC day. Immutable once published.
// ---------------------------------------------------------------------------

export function dailyConfig(date = new Date()) {
  const day = date.toISOString().slice(0, 10); // UTC day
  const seed = seedFromString('daily:' + day);
  const rng = createRng(seed);
  const patterns = ['none', 'pillars', 'lanes', 'cross', 'ring'];
  const pattern = patterns[nextInt(rng, patterns.length)];
  const size = 16 + nextInt(rng, 3) * 2;
  const smallCount = nextInt(rng, 3);
  const rivals = [];
  for (let i = 0; i < smallCount; i++) rivals.push({ tier: 'small', length: 2 + nextInt(rng, 2) });
  if (nextInt(rng, 2) === 0) rivals.push({ tier: 'big', length: 5 + nextInt(rng, 2) });
  return {
    id: 'daily-' + day,
    day,
    rulesetId: 'daily-v1',
    contentVersion: CONTENT_VERSION,
    seed,
    grid: { w: size, h: size },
    start: { x: Math.floor(size / 2), y: Math.floor(size / 2), dir: 'up', length: 3 },
    food: { count: 3, goldenChance: 0.1 + nextInt(rng, 3) * 0.05 },
    rivals,
    obstaclePattern: pattern,
    goals: [{ kind: 'score', count: 500 }],
    tickMs: 120,
    parTicks: 500,
    maxTicks: 900,
    mechanics: { allowUndo: false, rivalsEatFood: true },
    themeId: THEMES[nextInt(rng, THEMES.length)].id,
  };
}

// ---------------------------------------------------------------------------
// Practice — selectable difficulty; undo allowed; unranked.
// ---------------------------------------------------------------------------

export const PRACTICE_DIFFICULTIES = [
  { id: 'relaxed', name: 'Relaxed', tickMs: 170, rivals: [], obstacles: 'none', grid: { w: 16, h: 16 } },
  { id: 'steady', name: 'Steady', tickMs: 135, rivals: [{ tier: 'small', length: 2 }], obstacles: 'pillars', grid: { w: 16, h: 16 } },
  { id: 'brisk', name: 'Brisk', tickMs: 110, rivals: [{ tier: 'small', length: 3 }, { tier: 'big', length: 5 }], obstacles: 'lanes', grid: { w: 18, h: 18 } },
  { id: 'fierce', name: 'Fierce', tickMs: 90, rivals: [{ tier: 'small', length: 3 }, { tier: 'big', length: 6 }, { tier: 'big', length: 5 }], obstacles: 'cross', grid: { w: 20, h: 20 } },
];

export function practiceConfig(difficultyId, themeId) {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.id === difficultyId) || PRACTICE_DIFFICULTIES[0];
  return {
    id: 'practice-' + d.id,
    seed: seedFromString('practice:' + d.id + ':' + (themeId || 'meadow')),
    grid: d.grid,
    start: { x: Math.floor(d.grid.w / 2), y: Math.floor(d.grid.h / 2), dir: 'up', length: 3 },
    food: { count: 3, goldenChance: 0.1 },
    rivals: d.rivals.map((r) => ({ ...r })),
    obstaclePattern: d.obstacles,
    goals: [{ kind: 'score', count: 300 }],
    tickMs: d.tickMs,
    parTicks: 400,
    maxTicks: 0,
    mechanics: { allowUndo: true, rivalsEatFood: true },
    themeId: themeId || 'meadow',
    unranked: true,
  };
}

// Build a full rules-ready config from any content descriptor.
export function toRulesConfig(descriptor) {
  const grid = descriptor.grid;
  const obstacles = materializeObstacles(
    descriptor.obstaclePattern || descriptor.obstacles || 'none',
    grid, descriptor.seed, descriptor.obstacleDensity ?? 1);
  return {
    seed: descriptor.seed,
    grid,
    start: descriptor.start || { x: Math.floor(grid.w / 2), y: Math.floor(grid.h / 2), dir: 'up', length: 3 },
    food: descriptor.food,
    rivals: descriptor.rivals || [],
    obstacles,
    goals: descriptor.goals,
    tickMs: descriptor.tickMs,
    parTicks: descriptor.parTicks,
    maxTicks: descriptor.maxTicks || 0,
    moveLimit: descriptor.moveLimit || 0,
    mechanics: descriptor.mechanics || {},
  };
}

// ---------------------------------------------------------------------------
// Offline validators — prove basic legality, reachable goals, bounded
// duration, and absence of soft locks. Run in tests and at content load.
// ---------------------------------------------------------------------------

export function validateDescriptor(desc) {
  const problems = [];
  const cfg = toRulesConfig(desc);
  const { w, h } = cfg.grid;

  const inBounds = (c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h;
  if (!inBounds(cfg.start)) problems.push('start out of bounds');
  const occ = new Set(cfg.obstacles.map((c) => c.x + ',' + c.y));
  if (occ.has(cfg.start.x + ',' + cfg.start.y)) problems.push('start on obstacle');

  // Reachability: BFS from the start must reach enough free cells for food + play.
  const free = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!occ.has(x + ',' + y)) free.push({ x, y });
  if (free.length < (cfg.food ? cfg.food.count : 1) + 8) problems.push('too few free cells');
  const seen = new Set([cfg.start.x + ',' + cfg.start.y]);
  const queue = [{ x: cfg.start.x, y: cfg.start.y }];
  while (queue.length) {
    const c = queue.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const n = { x: c.x + dx, y: c.y + dy };
      const k = n.x + ',' + n.y;
      if (inBounds(n) && !occ.has(k) && !seen.has(k)) { seen.add(k); queue.push(n); }
    }
  }
  if (seen.size < Math.min(free.length, 40)) problems.push('reachable area too small');

  // Bounded duration: a hard cap must exist unless a goal can end the game.
  if (!cfg.maxTicks && !cfg.moveLimit && !(cfg.goals || []).length) {
    problems.push('unbounded session: no goals, move limit, or time cap');
  }
  for (const g of cfg.goals || []) {
    if (!Number.isInteger(g.count) || g.count <= 0) problems.push('goal count must be positive');
    if (g.kind === 'survive' && cfg.maxTicks && g.count > cfg.maxTicks) {
      problems.push('survive goal exceeds time cap');
    }
    if (g.kind === 'length' && g.count > seen.size) problems.push('length goal exceeds reachable space');
    if (g.kind === 'rivals' && (cfg.rivals || []).filter((r) => r.tier === 'small').length < g.count) {
      problems.push('not enough small rivals for rival goal');
    }
  }
  if (cfg.tickMs < 60 || cfg.tickMs > 500) problems.push('tickMs outside safe band');

  // Instantiation must succeed and produce a legal, hashable initial state.
  try {
    const s = createGame(cfg);
    if (!hashState(serializeState(s))) problems.push('initial state not hashable');
  } catch (e) {
    problems.push('createGame failed: ' + e.message);
  }
  return problems;
}

export function validateAllContent() {
  const report = [];
  for (const s of JOURNEY_STAGES) report.push({ id: s.id, problems: validateDescriptor(s) });
  for (const c of CHALLENGES) report.push({ id: c.id, problems: validateDescriptor(c) });
  for (const t of TUTORIALS) {
    report.push({ id: t.id, problems: validateDescriptor({ seed: seedFromString(t.id), ...t.config }) });
  }
  for (const d of PRACTICE_DIFFICULTIES) report.push({ id: 'practice-' + d.id, problems: validateDescriptor(practiceConfig(d.id)) });
  // A week of dailies.
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.UTC(2026, 0, 5 + i));
    report.push({ id: 'daily-' + date.toISOString().slice(0, 10), problems: validateDescriptor(dailyConfig(date)) });
  }
  return report;
}

export function contentHash() {
  return hashString(JSON.stringify({ v: CONTENT_VERSION, stages: JOURNEY_STAGES.length, challenges: CHALLENGES.length }));
}
