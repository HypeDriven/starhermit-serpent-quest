// Local persistence: versioned, checksummed documents in localStorage.
// Cloud sync is a host concern; this module is the durable local layer and
// keeps both snapshots on conflict (see mergeProgression).

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
  quality: 'auto', // auto | low | medium | high
  reducedMotion: false,
  highContrast: false,
  colorPalette: 'standard', // standard | deuteranopia | protanopia | tritanopia
  largeText: false,
  leftHanded: false,
  holdToPause: false,
  timingAssist: false, // slows tick rate one notch, unranked
  haptics: true,
  cameraView: 'default', // default | top
  bindings: {
    up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
    pause: ['Escape', 'KeyP'], confirm: ['Enter', 'Space'], cancel: ['Escape'],
    undo: ['KeyZ', 'Backspace'], hint: ['KeyH'], cameraReset: ['KeyC'],
  },
  tutorialDone: {},
  telemetryConsent: false,
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

// Conflict handling: keep both snapshots; a strict descendant wins silently,
// otherwise the player is asked (the UI surfaces `conflict` when present).
export function mergeProgression(local, remote) {
  if (!remote) return { merged: local, conflict: null };
  const localClears = Object.keys(local.stages || {}).length;
  const remoteClears = Object.keys(remote.stages || {}).length;
  const localIsDescendant = localClears >= remoteClears && (local.totalRounds || 0) >= (remote.totalRounds || 0);
  const remoteIsDescendant = remoteClears >= localClears && (remote.totalRounds || 0) >= (local.totalRounds || 0);
  if (localIsDescendant) return { merged: local, conflict: null };
  if (remoteIsDescendant) return { merged: remote, conflict: null };
  return { merged: local, conflict: { local, remote } };
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
