// The save model (js/progress.js): a cloud-save conflict keeps the best of both devices, the browser
// build's cloud slot migrates, and the game's options are validated (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeProgression, mergeBoards, normalize, mergeSave, sameSave, readForeign, pickOptions, defaultSave, DEFAULT_OPTIONS,
} from '../js/progress.js';

test('progression merge keeps every clear, lesson, achievement and the larger counters', () => {
  const local = {
    stages: { j01: { won: true, bestScore: 300, bestTicks: 140, attempts: 2 }, j02: { attempts: 3 } },
    tutorials: { 'tut-steer': { done: true } },
    achievements: { 'first-clear': { at: 200 } },
    masteryPoints: 4, totalRounds: 6,
    cosmetics: { unlocked: ['trail-leaf', 'trail-petal'], equipped: { trail: 'trail-petal' } },
    dailiesPlayed: { '2026-10-01': { score: 500, won: true } },
    currentStreakDays: 1, lastDailyDay: '2026-10-01',
  };
  const remote = {
    stages: { j01: { won: true, bestScore: 450, bestTicks: 160, attempts: 1 }, j02: { won: true, bestScore: 90, bestTicks: 200, attempts: 4 } },
    tutorials: { 'tut-eat': { done: true } },
    achievements: { 'first-clear': { at: 100 }, 'daily-streak-3': { at: 300 } },
    masteryPoints: 9, totalRounds: 5,
    cosmetics: { unlocked: ['trail-leaf', 'trail-spark'], equipped: { trail: 'trail-spark' } },
    dailiesPlayed: { '2026-10-01': { score: 200, won: false }, '2026-10-02': { score: 50, won: false } },
    currentStreakDays: 2, lastDailyDay: '2026-10-02',
  };
  const m = mergeProgression(local, remote);
  assert.deepEqual(m.stages.j01, { won: true, bestScore: 450, bestTicks: 140, attempts: 2 });
  assert.deepEqual(m.stages.j02, { won: true, bestScore: 90, bestTicks: 200, attempts: 4 });
  assert.deepEqual(Object.keys(m.tutorials).sort(), ['tut-eat', 'tut-steer']);
  assert.deepEqual(m.achievements['first-clear'], { at: 100 });
  assert.ok(m.achievements['daily-streak-3']);
  assert.equal(m.masteryPoints, 9);
  assert.equal(m.totalRounds, 6);
  assert.deepEqual(m.cosmetics.unlocked.sort(), ['trail-leaf', 'trail-petal', 'trail-spark']);
  assert.equal(m.cosmetics.equipped.trail, 'trail-petal');
  assert.equal(m.dailiesPlayed['2026-10-01'].score, 500);
  assert.equal(m.dailiesPlayed['2026-10-02'].score, 50);
  assert.equal(m.lastDailyDay, '2026-10-02');
  assert.equal(m.currentStreakDays, 2);
});

test('board merge keeps the better daily/challenge entry and the union of chase runs', () => {
  const e = (score, sessionId) => ({ name: 'A', score, won: true, invalidActions: 0, elapsedMs: 1000, sessionId, when: '2026-10-01' });
  const m = mergeBoards(
    { daily: { d1: e(100, 'a') }, chase: [e(300, 'x'), e(100, 'y')], challenges: { c1: e(50, 'c') } },
    { daily: { d1: e(200, 'b'), d2: e(10, 'q') }, chase: [e(300, 'x'), e(250, 'z')], challenges: {} },
  );
  assert.equal(m.daily.d1.score, 200);
  assert.equal(m.daily.d2.score, 10);
  assert.deepEqual(m.chase.map((r) => r.score), [300, 250, 100]);
  assert.equal(m.challenges.c1.score, 50);
});

test('a save from anything is complete; ghosts are capped', () => {
  const s = normalize(null);
  assert.deepEqual(s, defaultSave());
  const ghosts = {};
  for (let i = 0; i < 30; i++) ghosts['ghost:' + i] = [];
  const n = normalize({ progression: { masteryPoints: 'x', stages: [] }, boards: { chase: 'bad', ghosts }, name: 'x'.repeat(40), snapshot: 3 });
  assert.equal(n.progression.masteryPoints, 0);
  assert.deepEqual(n.progression.stages, {});
  assert.deepEqual(n.boards.chase, []);
  assert.equal(Object.keys(n.boards.ghosts).length, 16);
  assert.ok(n.boards.ghosts['ghost:29']);
  assert.equal(n.name.length, 24);
  assert.equal(n.snapshot, null);
});

test('two devices merge: progress from both, this device keeps its paused round and name', () => {
  const a = normalize({ progression: { stages: { j01: { won: true, bestScore: 300 } }, totalRounds: 3 }, snapshot: { mode: 'journey' }, name: 'Fern' });
  const b = normalize({ progression: { stages: { j02: { won: true, bestScore: 90 } }, totalRounds: 7 }, name: 'Ivy' });
  const m = mergeSave(b, a);
  assert.ok(m.progression.stages.j01.won && m.progression.stages.j02.won);
  assert.equal(m.progression.totalRounds, 7);
  assert.deepEqual(m.snapshot, { mode: 'journey' });
  assert.equal(m.name, 'Fern');
  assert.ok(sameSave(m, mergeSave(b, m)));
});

test('the browser build\'s cloud slot ({ version, savedAt, progression, boards }) reads as a save', () => {
  const text = JSON.stringify({ version: 1, savedAt: 5, progression: { masteryPoints: 12, stages: { j01: { won: true } } }, boards: { chase: [{ score: 40, sessionId: 's', when: 'w' }] } });
  const s = readForeign(text);
  assert.equal(s.progression.masteryPoints, 12);
  assert.equal(s.boards.chase.length, 1);
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign(JSON.stringify({ other: 1 })), null);
});

test('options: only valid values pass', () => {
  assert.deepEqual(pickOptions({ colorPalette: 'tritanopia', cameraView: 'top', haptics: false, captions: 'yes', leftHanded: true }),
    { colorPalette: 'tritanopia', cameraView: 'top', haptics: false, leftHanded: true });
  assert.deepEqual(pickOptions({ colorPalette: 'neon' }), {});
  assert.equal(DEFAULT_OPTIONS.captions, true);
});
