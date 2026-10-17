// Local persistence: versioned, checksummed documents in localStorage.
// Cloud sync is a host concern; this module is the durable local layer and
// merges a cloud copy with the local one without dropping either side's
// progress (mergeProgression / mergeBoards).

import { hashString } from './rng.js';

const PREFIX = 'serpentquest.';
const DOC_VERSION = 1;

function safeGet(key) {
  try { return window.localStorage.getItem(PREFIX + key); } catch { return null; }
}
function safeSet(key, value) {
  try { window.localStorage.setItem(PREFIX + key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { window.localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

function wrap(doc) {
  const body = JSON.stringify({ v: DOC_VERSION, at: Date.now(), doc });
  return JSON.stringify({ body, checksum: hashString(body) });
}

function unwrap(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.body || hashString(parsed.body) !== parsed.checksum) return null;
    const envelope = JSON.parse(parsed.body);
    return envelope.doc;
  } catch { return null; }
}

// --- Settings (audio, graphics, accessibility, controls, tutorial flags) ---

export const DEFAULT_SETTINGS = {
  version: 1,
  music: 0.7, sfx: 0.9, ambience: 0.5, voice: 0.8, muted: false,
  quality: 'auto', // graphics preset: auto | low | balanced | high | ultra (old 'medium' → balanced)
  graphics: {}, // render_scale, adaptive, show_fps and per-category overrides (js/gfx.js)
  reducedMotion: false,
  highContrast: false,
  colorPalette: 'standard', // standard | deuteranopia | protanopia | tritanopia
  largeText: false,
  leftHanded: false,
  holdToPause: false,
  timingAssist: false, // slows tick rate one notch, unranked
  haptics: true,
  captions: true, // text cues for meaningful sounds (death, win, etc.)
  cameraView: 'default', // default | top
  bindings: {
    up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
    pause: ['Escape', 'KeyP'], confirm: ['Enter', 'Space'], cancel: ['Escape'],
    undo: ['KeyZ', 'Backspace'], hint: ['KeyH'], cameraReset: ['KeyC'],
  },
  tutorialDone: {},
};

export function loadSettings() {
  const doc = unwrap(safeGet('settings'));
  if (!doc) return structuredClone(DEFAULT_SETTINGS);
  return { ...structuredClone(DEFAULT_SETTINGS), ...doc, bindings: { ...DEFAULT_SETTINGS.bindings, ...(doc.bindings || {}) } };
}

export function saveSettings(settings) {
  return safeSet('settings', wrap(settings));
}

// --- Profile ---

export function loadProfile() {
  const doc = unwrap(safeGet('profile'));
  if (doc) return doc;
  return {
    version: 1,
    id: 'guest-' + hashString(String(Math.random()) + Date.now()).slice(0, 8),
    displayName: 'Guest Gardener',
    avatar: 'sprout',
    isGuest: true,
    createdAt: Date.now(),
  };
}

export function saveProfile(profile) {
  return safeSet('profile', wrap(profile));
}

// --- Progression (journey clears, mastery, achievements, cosmetics) ---

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

export function loadProgression() {
  const doc = unwrap(safeGet('progression'));
  if (!doc) return structuredClone(DEFAULT_PROGRESSION);
  return { ...structuredClone(DEFAULT_PROGRESSION), ...doc };
}

export function saveProgression(p) {
  return safeSet('progression', wrap(p));
}

// Conflict handling: merge, never drop. Per stage the better record (won,
// best score, fewest ticks, most attempts); every lesson, achievement (earliest
// unlock), unlocked cosmetic and played daily (better score); the larger
// counters; the later daily streak; this device's equipped cosmetic.
const n0 = (v) => (Number.isFinite(v) ? v : 0);
export function mergeProgression(local, remote) {
  const d = structuredClone(DEFAULT_PROGRESSION);
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

// --- Last safe snapshot (resume after crash/close) ---

export function saveSnapshot(sessionId, serializedState) {
  return safeSet('snapshot', wrap({ sessionId, state: serializedState, at: Date.now() }));
}
export function loadSnapshot() {
  return unwrap(safeGet('snapshot'));
}
export function clearSnapshot() {
  safeRemove('snapshot');
}

// --- Local leaderboards (score chase, daily, practice bests) ---

export function loadBoards() {
  return unwrap(safeGet('boards')) || { daily: {}, chase: [], challenges: {} };
}
export function saveBoards(b) {
  return safeSet('boards', wrap(b));
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
