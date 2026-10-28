// Serpent Quest — the save document, its merge, the old cloud slot and the
// game's own options. Pure (no storage, no platform): the engine client
// (native/platform.ts) and the node tests share it. The progression and
// board merges are the browser build's js/storage.js, unchanged in what they
// decide (mergeProgression / mergeBoards / compareResults).
//
// The engine save is { v, progression, boards, snapshot, name }:
//  - progression: journey clears, lessons, achievements, mastery, cosmetics,
//    dailies played, rounds, streak (serpentquest.progression);
//  - boards: the local daily / weekly chase / challenge bests and the cached
//    garden-spirit runs (serpentquest.boards);
//  - snapshot: the paused round to resume (serpentquest.snapshot);
//  - name: the guest's local display name (serpentquest.profile).
// The browser build mirrored { version, savedAt, progression, boards } to the
// cloud slot game:<slug> through the JS SDK: readForeign() reads that text.

import { canonicalJson } from './rng.js';

export const SAVE_VERSION = 1;
const MAX_GHOST_KEYS = 16;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const clone = (x) => JSON.parse(JSON.stringify(x));

export const DEFAULT_PROGRESSION = {
  version: 1,
  stages: {}, // id -> { won, bestScore, bestTicks, attempts }
  tutorials: {}, // id -> { done }
  achievements: {}, // key -> { at }
  masteryPoints: 0,
  cosmetics: { unlocked: ['trail-leaf'], equipped: { trail: 'trail-leaf' } },
  dailiesPlayed: {}, // day -> { score, won }
  totalRounds: 0,
  currentStreakDays: 0,
  lastDailyDay: null,
};


export function emptyBoards() { return { daily: {}, chase: [], challenges: {} }; }

/** A progression document from anything (missing fields from the default one). */
export function normalizeProgression(raw) {
  const p = obj(raw) ? clone(raw) : {};
  const out = { ...clone(DEFAULT_PROGRESSION), ...p };
  for (const k of ['stages', 'tutorials', 'achievements', 'dailiesPlayed']) out[k] = obj(out[k]) || {};
  // mergeProgression writes attempts on every stage it merges: keep it on every record so a merge is stable
  for (const id of Object.keys(out.stages)) {
    const r = obj(out.stages[id]);
    if (!r) { delete out.stages[id]; continue; }
    if (!Number.isFinite(r.attempts)) r.attempts = 0;
  }
  const c = obj(out.cosmetics) || {};
  out.cosmetics = {
    unlocked: Array.isArray(c.unlocked) ? c.unlocked.filter((x) => typeof x === 'string') : ['trail-leaf'],
    equipped: { trail: 'trail-leaf', ...(obj(c.equipped) || {}) },
  };
  for (const k of ['masteryPoints', 'totalRounds', 'currentStreakDays']) out[k] = Number.isFinite(out[k]) ? out[k] : 0;
  if (typeof out.lastDailyDay !== 'string') out.lastDailyDay = null;
  return out;
}

export function normalizeBoards(raw) {
  const b = obj(raw) ? clone(raw) : {};
  const out = { ...emptyBoards(), ...b };
  out.daily = obj(out.daily) || {};
  out.challenges = obj(out.challenges) || {};
  out.chase = Array.isArray(out.chase) ? out.chase.filter((e) => obj(e)) : [];
  if (obj(out.ghosts)) {
    const keys = Object.keys(out.ghosts);
    if (keys.length > MAX_GHOST_KEYS) for (const k of keys.slice(0, keys.length - MAX_GHOST_KEYS)) delete out.ghosts[k];
  } else delete out.ghosts;
  return out;
}

export function defaultSave() {
  return { v: SAVE_VERSION, progression: normalizeProgression(null), boards: emptyBoards(), snapshot: null, name: '' };
}

/** A save document from anything. */
export function normalize(raw) {
  const d = obj(raw) || {};
  return {
    v: SAVE_VERSION,
    progression: normalizeProgression(d.progression),
    boards: normalizeBoards(d.boards),
    snapshot: obj(d.snapshot) ? d.snapshot : null,
    name: typeof d.name === 'string' ? d.name.slice(0, 24) : '',
  };
}

// Conflict handling: merge, never drop. Per stage the better record (won,
// best score, fewest ticks, most attempts); every lesson, achievement (earliest
// unlock), unlocked cosmetic and played daily (better score); the larger
// counters; the later daily streak; this device's equipped cosmetic.
const n0 = (v) => (Number.isFinite(v) ? v : 0);
export function mergeProgression(local, remote) {
  const d = clone(DEFAULT_PROGRESSION);
  const a = { ...d, ...(local || {}) };
  const b = { ...d, ...(remote || {}) };
  const out = { ...b, ...a };
  out.stages = {};
  for (const id of new Set([...Object.keys(a.stages || {}), ...Object.keys(b.stages || {})])) {
    const x = a.stages?.[id], y = b.stages?.[id];
    if (!x || !y) { out.stages[id] = { ...(x || y) }; continue; }
    const rec = { ...y, ...x, won: !!(x.won || y.won), attempts: Math.max(n0(x.attempts), n0(y.attempts)) };
    const best = Math.max(n0(x.bestScore), n0(y.bestScore));
    if (best) rec.bestScore = best;
    const ticks = [x.bestTicks, y.bestTicks].filter((t) => Number.isFinite(t) && t > 0);
    if (ticks.length) rec.bestTicks = Math.min(...ticks);
    out.stages[id] = rec;
  }
  out.tutorials = { ...(b.tutorials || {}), ...(a.tutorials || {}) };
  out.achievements = {};
  for (const k of new Set([...Object.keys(a.achievements || {}), ...Object.keys(b.achievements || {})])) {
    const x = a.achievements?.[k], y = b.achievements?.[k];
    out.achievements[k] = !x ? y : !y ? x : (n0(x.at) && n0(x.at) < n0(y.at) ? x : y);
  }
  out.masteryPoints = Math.max(n0(a.masteryPoints), n0(b.masteryPoints));
  out.totalRounds = Math.max(n0(a.totalRounds), n0(b.totalRounds));
  const unlocked = [...new Set([...(b.cosmetics?.unlocked || []), ...(a.cosmetics?.unlocked || [])])];
  out.cosmetics = { unlocked, equipped: { ...(b.cosmetics?.equipped || {}), ...(a.cosmetics?.equipped || {}) } };
  out.dailiesPlayed = {};
  for (const day of new Set([...Object.keys(a.dailiesPlayed || {}), ...Object.keys(b.dailiesPlayed || {})])) {
    const x = a.dailiesPlayed?.[day], y = b.dailiesPlayed?.[day];
    out.dailiesPlayed[day] = !x ? y : !y ? x : (n0(x.score) >= n0(y.score) ? x : y);
  }
  const la = a.lastDailyDay || '', lb = b.lastDailyDay || '';
  if (la === lb) out.currentStreakDays = Math.max(n0(a.currentStreakDays), n0(b.currentStreakDays));
  else out.currentStreakDays = la > lb ? n0(a.currentStreakDays) : n0(b.currentStreakDays);
  out.lastDailyDay = (la > lb ? la : lb) || null;
  return out;
}

/** Merge local and cloud boards: the better entry per day/challenge, the union of chase runs (top 20). */
export function mergeBoards(local, remote) {
  const a = { daily: {}, chase: [], challenges: {}, ...(local || {}) };
  const b = { daily: {}, chase: [], challenges: {}, ...(remote || {}) };
  const out = { ...b, ...a, daily: {}, challenges: {} };
  for (const key of ['daily', 'challenges']) {
    for (const id of new Set([...Object.keys(a[key] || {}), ...Object.keys(b[key] || {})])) {
      const x = a[key]?.[id], y = b[key]?.[id];
      out[key][id] = !x ? y : !y ? x : (compareResults(x, y) <= 0 ? x : y);
    }
  }
  const seen = new Set();
  out.chase = [...(a.chase || []), ...(b.chase || [])]
    .filter((e) => { const k = `${e.sessionId}|${e.score}|${e.when}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort(compareResults).slice(0, 20);
  if (a.ghosts || b.ghosts) out.ghosts = { ...(b.ghosts || {}), ...(a.ghosts || {}) };
  return out;
}

/** Merge two saves (another device saved since, or the old cloud slot): this device's paused round and name win. */
export function mergeSave(remote, local) {
  const a = normalize(remote), b = normalize(local);
  return {
    v: SAVE_VERSION,
    progression: normalizeProgression(mergeProgression(b.progression, a.progression)),
    boards: normalizeBoards(mergeBoards(b.boards, a.boards)),
    snapshot: b.snapshot ?? a.snapshot,
    name: b.name || a.name,
  };
}

/** Whether two saves say the same (key order aside: merges rebuild their maps). */
export function sameSave(a, b) {
  return canonicalJson(normalize(a)) === canonicalJson(normalize(b));
}

/** The browser build's cloud slot text ({ version, savedAt, progression, boards }) as a save, or null. */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const d = JSON.parse(text);
    if (!obj(d) || !(obj(d.progression) || obj(d.boards))) return null;
    return normalize({ progression: d.progression, boards: d.boards });
  } catch { return null; }
}

// --- the game's own options ---------------------------------------------------------------------
// The browser build's settings that stay the game's (engine `settings`, synced with the account): the
// colour palette, the left-handed tray, haptics, sound captions, timing assistance and the camera view.
// Volumes, mute, graphics, reduced motion, high contrast, larger text, key bindings and the language are
// the runtime's Options now.
export const PALETTES = ['standard', 'deuteranopia', 'protanopia', 'tritanopia'];
export const CAMERA_VIEWS = ['default', 'top'];
export const DEFAULT_OPTIONS = { colorPalette: 'standard', leftHanded: false, haptics: true, captions: true, timingAssist: false, cameraView: 'default' };
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
/** The browser build's keys in the account's settings KV (every setting but version and bindings), removed once migrated. */
export const BROWSER_KEYS = ['music', 'sfx', 'ambience', 'voice', 'muted', 'quality', 'graphics', 'reducedMotion', 'highContrast',
  'colorPalette', 'largeText', 'leftHanded', 'holdToPause', 'timingAssist', 'haptics', 'captions', 'cameraView', 'tutorialDone'];

/** The valid option values among `raw`. */
export function pickOptions(raw) {
  const o = obj(raw) || {};
  const out = {};
  if (PALETTES.includes(o.colorPalette)) out.colorPalette = o.colorPalette;
  if (CAMERA_VIEWS.includes(o.cameraView)) out.cameraView = o.cameraView;
  for (const k of ['leftHanded', 'haptics', 'captions', 'timingAssist']) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

// Tie-break order: primary objective completion, fewer invalid actions,
// lower authoritative elapsed time, then stable session identifier.
export function compareResults(a, b) {
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}
