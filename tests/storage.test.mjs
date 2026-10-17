// mergeProgression / mergeBoards: a cloud-save conflict keeps the best of both devices (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProgression, mergeBoards } from '../js/storage.js';

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
