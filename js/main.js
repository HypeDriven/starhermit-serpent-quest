// Bootstrap + orchestration: owns the application state machine, wires the
// rules/session/render/ui/audio/platform modules together, and implements
// mode flows, persistence, achievements, leaderboards, and replays.

import { createRng, nextFloat, nextInt, seedFromString, hashString } from './rng.js';
import {
  createGame, getLegalActions, getSafeTurns, applyCommand, advanceTick,
} from './rules.js';
import {
  THEMES, themeById, JOURNEY_STAGES, TUTORIALS, CHALLENGES,
  dailyConfig, practiceConfig, PRACTICE_DIFFICULTIES, toRulesConfig, stageById,
} from './content.js';
import {
  loadSettings, saveSettings, loadProfile, saveProfile,
  loadProgression, saveProgression, loadBoards, saveBoards,
  saveSnapshot, loadSnapshot, clearSnapshot, compareResults,
  mergeProgression,
} from './storage.js';
import { GameSession, BUILD_VERSION } from './session.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import { createPlatform } from './platform.js';

// ---------------------------------------------------------------------------
// Static declarations
// ---------------------------------------------------------------------------

const ACHIEVEMENTS = [
  { key: 'first-clear', name: 'First Bloom', desc: 'Complete your first journey stage.' },
  { key: 'mechanic-mastery', name: 'Garden Scholar', desc: 'Complete every lesson in Learn mode.' },
  { key: 'daily-streak-3', name: 'Three Sunrises', desc: 'Play the daily challenge three days in a row.' },
  { key: 'grand-milestone', name: 'Crucible Clearer', desc: 'Clear journey stage 30, Mastery: Crucible.' },
  { key: 'seasoned-gardener', name: 'Seasoned Gardener', desc: 'Finish 50 rounds of Serpent Quest.' },
];

const COSMETICS = [
  { id: 'trail-leaf', name: 'Leaf Scales', cost: 0, tint: null },
  { id: 'trail-petal', name: 'Petal Scales', cost: 30, tint: 0xd96a9a },
  { id: 'trail-spark', name: 'Sunspark Scales', cost: 60, tint: 0xd9a83c },
  { id: 'trail-frost', name: 'Frost Scales', cost: 100, tint: 0x5a9ad9 },
];

const REASON_TEXT = {
  'crashed-wall': 'The hedge wall wins this round.',
  'crashed-self': 'Tangled in your own coils.',
  'crashed-obstacle': 'A rock ended that path.',
  'eaten-by-rival': 'A hunter caught your serpent.',
  'moves-exhausted': 'Out of moves.',
  'time-up': 'Time ran out.',
  abandoned: 'Round left unfinished.',
};

const MODE_LABELS = { learn: 'Lesson', journey: 'Journey', daily: 'Daily', practice: 'Practice', challenge: 'Challenge', chase: 'Score chase', replay: 'Replay' };

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const settings = loadSettings();
const profile = loadProfile();
let progression = loadProgression();
let boards = loadBoards();
const platform = createPlatform();

let renderer = null;
let audio = null;
let ui = null;

let session = null;          // active GameSession
let currentFlow = null;      // { mode, descriptor, config, ranked, tutorial? }
let navStack = [];
let attract = null;          // attract-mode session behind the title screen
let lastHudTick = -1;
let pausedByBackground = false;
let lessonTracker = null;    // { tutorial, actions, events, done }
let replaySource = null;     // replay envelope being watched
let gamepadState = { axes: [0, 0], buttons: [] };
let setupState = null;       // options chosen on the setup screen

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  ui = createUI({ onAction });
  ui.setLoading(20, 'Checking the soil…');

  // Honor the OS reduced-motion preference on first run (before any stored choice).
  try {
    if (!localStorage.getItem('serpentquest.settings') && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settings.reducedMotion = true;
    }
  } catch { /* no storage */ }

  if (!webglAvailable()) {
    ui.showCompat();
    return;
  }

  ui.setLoading(40, 'Planting the garden…');
  const canvas = document.getElementById('game-canvas');
  renderer = createRenderer({
    canvas,
    getSettings: () => settings,
    onSteer: (dir) => steer(dir),
    onCellPicked: () => {},
    onContextLost: () => {
      ui.toast('Graphics context lost — restoring…', 'warn');
      ui.announce('Graphics interrupted. Restoring the garden.', true);
    },
    onContextRestored: () => {
      if (session) renderer.syncSnapshot(session.getSnapshot(), 1);
      ui.toast('Garden restored.');
    },
  });
  audio = createAudio({ getSettings: () => settings });

  ui.setLoading(70, 'Opening the gates…');
  ui.wireStatic(settings);
  wireGlobalInput();
  platform.syncTime();
  platform.activityStart();
  window.addEventListener('beforeunload', () => platform.activityEnd());
  window.addEventListener('pagehide', () => platform.cloudSync.flush());
  initHostedState();

  ui.setLoading(90, 'Almost there…');
  await nextFrame();
  startAttract();
  ui.showChrome(true);
  updateDailyChip();
  ui.finishLoading();
  telemetry('start');
  goTitle();
  requestAnimationFrame(frame);
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function nextFrame() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }

function telemetry(event, data) {
  platform.telemetry(event, data, settings.telemetryConsent);
}

// ---------------------------------------------------------------------------
// Hosted state: cloud save mirror + account display name
// ---------------------------------------------------------------------------

// Remote-preferred load: the platform slot wins on conflict; localStorage
// remains the offline cache either way.
async function initHostedState() {
  if (!platform.hosted) return;
  platform.cloudSync.onStatus(() => {
    if (ui.activeScreen === 'profile') showProfile();
  });
  try {
    const remote = await platform.cloudSync.load();
    if (remote && (remote.progression || remote.boards)) {
      if (remote.progression) {
        const m = mergeProgression(progression, remote.progression);
        progression = m.conflict ? remote.progression : m.merged;
      }
      if (remote.boards && typeof remote.boards === 'object') {
        boards = { daily: {}, chase: [], challenges: {}, ...remote.boards };
      }
      saveProgression(progression);
      saveBoards(boards);
    }
  } catch { /* local cache stays authoritative */ }
  // Nickname from the account profile (never /me, never usernames); rendered
  // in the topbar, title, and boards via profile.displayName.
  platform.fetchProfileName().then((name) => {
    if (!name) return;
    profile.displayName = name;
    profile.isGuest = false;
    saveProfile(profile);
    ui.updateTopbar(topbarVM());
    if (ui.activeScreen === 'title') goTitle();
  }).catch(() => {});
}

// Cloud mirror of the local save doc: debounced by the adapter, flushed on
// pagehide. No-op offline — localStorage is the cache there.
function syncCloudSave() {
  if (!platform.hosted) return;
  platform.cloudSync.schedule({ version: 1, savedAt: Date.now(), progression, boards });
}

function syncStatusText() {
  const labels = {
    idle: 'Cloud save: ready',
    saving: 'Cloud save: saving…',
    synced: 'Cloud save: synced',
    error: 'Cloud save: offline — will retry',
    offline: 'Cloud save: offline',
  };
  return labels[platform.cloudSync.status] || '';
}

// ---------------------------------------------------------------------------
// Quality + theme helpers
// ---------------------------------------------------------------------------

function resolveQuality() {
  if (settings.quality !== 'auto') return settings.quality;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 760;
  const lowMem = navigator.deviceMemory && navigator.deviceMemory < 4;
  return (coarse && (small || lowMem)) ? 'low' : (coarse || small ? 'medium' : 'high');
}

function themedFor(descriptor) {
  const base = themeById(descriptor.themeId);
  const equipped = progression.cosmetics.equipped.trail;
  const cosmetic = COSMETICS.find((c) => c.id === equipped);
  if (cosmetic && cosmetic.tint != null) {
    return { ...base, snakeHead: cosmetic.tint, snakeBody: cosmetic.tint };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function goTitle() {
  navStack = [];
  stopSession();
  startAttract();
  const snap = loadSnapshot();
  const cleared = Object.values(progression.stages).filter((s) => s.won).length;
  ui.showScreen('title', {
    title: 'Serpent Quest',
    autofocus: '1',
    dailyLabel: dailyLabel(),
    snapshot: snap ? { label: snapshotLabel(snap) } : null,
    progressText: `Journey: ${cleared} / ${JOURNEY_STAGES.length} stages cleared · Mastery ${progression.masteryPoints} · ${profile.displayName}`,
  });
  ui.setHudVisible(false);
  ui.updateRails(null);
}

function navigate(name) {
  if (ui.activeScreen && ui.activeScreen !== name) navStack.push(ui.activeScreen);
}

function goBack() {
  const prev = navStack.pop();
  if (prev) showNavScreen(prev);
  else if (session && session.phase !== 'done') ui.showScreen(null); // return to the paused round
  else goTitle();
}

function showNavScreen(name) {
  switch (name) {
    case 'modes': ui.showScreen('modes', { title: 'Modes' }); break;
    case 'journey': showJourney(); break;
    case 'learn': showLearn(); break;
    case 'challenges': showChallenges(); break;
    case 'boards': showBoards(); break;
    case 'progression': showProgression(); break;
    case 'profile': showProfile(); break;
    case 'help': ui.showScreen('help', { title: 'Help', bindings: settings.bindings }); break;
    case 'settings': ui.showScreen('settings', { title: 'Settings', settings }); break;
    case 'setup': if (setupState) showSetup(setupState.flow); break;
    default: goTitle();
  }
}

function showJourney() {
  const clearedCount = Object.values(progression.stages).filter((s) => s.won).length;
  ui.showScreen('journey', {
    title: 'Journey',
    summary: `${clearedCount} of ${JOURNEY_STAGES.length} cleared. Mastery stages award extra points.`,
    stages: JOURNEY_STAGES.map((st, i) => {
      const rec = progression.stages[st.id];
      const locked = i > 0 && !progression.stages[JOURNEY_STAGES[i - 1].id]?.won;
      return { id: st.id, index: st.index, name: st.name, mastery: st.kind === 'mastery', locked, won: !!rec?.won, bestScore: rec?.bestScore || 0 };
    }),
  });
}

function showLearn() {
  ui.showScreen('learn', {
    title: 'Learn',
    tutorials: TUTORIALS.map((t) => ({ id: t.id, name: t.name, done: !!progression.tutorials[t.id]?.done })),
  });
}

function showChallenges() {
  ui.showScreen('challenges', {
    title: 'Challenges',
    challenges: CHALLENGES.map((c) => ({ id: c.id, name: c.name, desc: c.desc, best: boards.challenges[c.id]?.score || 0 })),
  });
}

function showProgression() {
  const cleared = Object.values(progression.stages).filter((s) => s.won).length;
  ui.showScreen('progression', {
    title: 'Progression',
    journeyText: `${cleared} / ${JOURNEY_STAGES.length} journey stages cleared.`,
    masteryText: `${progression.masteryPoints} mastery points · ${progression.totalRounds} rounds played · daily streak ${progression.currentStreakDays}`,
    achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: !!progression.achievements[a.key] })),
    cosmetics: COSMETICS.map((c) => ({
      ...c,
      unlocked: progression.cosmetics.unlocked.includes(c.id) || progression.masteryPoints >= c.cost,
      equipped: progression.cosmetics.equipped.trail === c.id,
    })),
  });
}

function showProfile() {
  ui.showScreen('profile', {
    title: 'Profile',
    profile,
    readOnly: platform.hosted,
    syncText: platform.hosted ? syncStatusText() : '',
    accountText: platform.hosted
      ? 'Signed in through the host. Your garden name comes from your account profile.'
      : 'Playing as a local guest. Progress is stored on this device; sign in through the host for durable cloud progress.',
  });
}

// ---------------------------------------------------------------------------
// Boards (score chase / daily / friends)
// ---------------------------------------------------------------------------

function boardEntryFromResults(results, name, me) {
  return {
    name, me: !!me,
    score: results.score.total,
    won: results.won,
    invalidActions: results.invalidActions,
    elapsedMs: results.elapsedMs,
    sessionId: results.sessionId,
    ruleset: results.rulesetId,
    seed: '0x' + results.seed.toString(16),
    when: new Date().toISOString().slice(0, 10),
  };
}

function ghostEntries(config, rulesetId) {
  const key = 'ghost:' + rulesetId + ':' + hashString(JSON.stringify(config.grid) + config.seed);
  boards.ghosts = boards.ghosts || {};
  if (!boards.ghosts[key]) {
    const spirits = [['Bramble', 0.9], ['Moss', 0.65], ['Thistle', 0.4]];
    boards.ghosts[key] = spirits.map(([name, skill], i) => {
      const s = ghostRun(config, seedFromString(key + name), skill);
      return {
        name: name + ' (spirit)', me: false,
        score: s.score.total, won: s.status === 'won',
        invalidActions: 0, elapsedMs: s.tick * config.tickMs,
        sessionId: 'ghost-' + i, ruleset: rulesetId,
        seed: '0x' + config.seed.toString(16), when: '—',
      };
    });
    saveBoards(boards);
  }
  return boards.ghosts[key];
}

// Scripted benchmark player — uses only the public rules API.
function ghostRun(config, seed, skill) {
  const rng = createRng(seed);
  let s = createGame(config);
  const cap = (config.maxTicks || 1500) + 50;
  let steps = 0;
  while (s.status === 'active' && steps++ < cap) {
    const head = s.snake.body[0];
    const legal = getLegalActions(s).map((a) => a.dir);
    const safe = getSafeTurns(s).map((a) => a.dir);
    if (!legal.length) break;
    let dir;
    const food = nearestFood(s, head);
    if (food && nextFloat(rng) < skill) {
      const want = Math.abs(food.x - head.x) > Math.abs(food.y - head.y)
        ? (food.x > head.x ? 'right' : 'left')
        : (food.y > head.y ? 'down' : 'up');
      const alt = Math.abs(food.x - head.x) > Math.abs(food.y - head.y)
        ? (food.y > head.y ? 'down' : 'up')
        : (food.x > head.x ? 'right' : 'left');
      dir = [want, alt].find((d) => safe.includes(d)) || safe[0] || legal[0];
    } else {
      dir = safe.length ? safe[nextInt(rng, safe.length)] : legal[0];
    }
    if (dir && dir !== s.snake.dir) s = applyCommand(s, { type: 'turn', dir }).state;
    s = advanceTick(s).state;
  }
  return s;
}

function nearestFood(state, head) {
  let best = null, bestD = Infinity;
  for (const f of state.food) {
    const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

async function showBoards() {
  const chaseDesc = chaseDescriptor();
  const dailyDesc = dailyConfig(platform.now());
  const chaseCfg = toRulesConfig(chaseDesc);
  const dailyCfg = toRulesConfig(dailyDesc);

  const chaseLocal = (boards.chase || []).map((e) => ({ ...e }));
  const dailyLocal = boards.daily[dailyDesc.day] ? [boards.daily[dailyDesc.day]] : [];

  const mkBoard = (name, locals, config, rulesetId) => {
    const entries = [...locals, ...ghostEntries(config, rulesetId)];
    entries.sort(compareResults);
    return { name, entries: entries.slice(0, 10), casual: !platform.hosted };
  };

  const boardsVM = [
    mkBoard('Weekly chase', chaseLocal, chaseCfg, chaseDesc.rulesetId),
    mkBoard('Daily', dailyLocal, dailyCfg, dailyDesc.rulesetId),
  ];

  if (platform.hosted) {
    // Platform boards are read-only: one global list plus a friends-filtered
    // view, nicknames resolved through the profile helper.
    const [global, friends] = await Promise.all([
      platform.fetchLeaderboard(false),
      platform.fetchLeaderboard(true),
    ]);
    if (global) boardsVM.push({ name: 'Global', entries: global.slice(0, 10), casual: false });
    if (friends) boardsVM.push({ name: 'Friends', entries: friends.slice(0, 10), casual: false });
    if (!global && !friends) boardsVM.push({ name: 'Friends', entries: [], casual: true });
  } else {
    boardsVM.push({ name: 'Friends', entries: [], casual: true });
  }
  ui.showScreen('boards', { title: 'Leaderboards', boards: boardsVM });
}

// ---------------------------------------------------------------------------
// Mode setup
// ---------------------------------------------------------------------------

function describeFacts(desc, config) {
  const facts = [];
  const goalText = { food: 'eat berries', length: 'grow long', rivals: 'defeat small rivals', survive: 'survive', score: 'score points' };
  if (desc.goals?.length) {
    facts.push('Goals: ' + desc.goals.map((g) => `${goalText[g.kind] || g.kind} (${g.count})`).join(' + '));
  } else {
    facts.push('No set goals — survive and score as much as you can.');
  }
  facts.push(`Arena ${config.grid.w}×${config.grid.h}${config.obstacles.length ? ' with obstacles' : ', open ground'}`);
  const small = (desc.rivals || []).filter((r) => r.tier === 'small').length;
  const big = (desc.rivals || []).filter((r) => r.tier === 'big').length;
  if (small || big) facts.push(`Rivals: ${small ? small + ' prey' : ''}${small && big ? ', ' : ''}${big ? big + ' hunter' + (big > 1 ? 's' : '') : ''}`);
  if (desc.moveLimit) facts.push(`Move limit: ${desc.moveLimit}`);
  if (desc.maxTicks) facts.push(`Time cap: ${Math.round(desc.maxTicks * desc.tickMs / 1000)}s`);
  facts.push(`Speed: ${desc.tickMs <= 100 ? 'very fast' : desc.tickMs <= 125 ? 'fast' : desc.tickMs <= 150 ? 'steady' : 'relaxed'}`);
  return facts;
}

function durationText(desc) {
  const ticks = desc.parTicks || desc.maxTicks || 400;
  const secs = Math.round(ticks * desc.tickMs / 1000);
  return '~' + Math.max(1, Math.round(secs / 60)) + ' min';
}

function chaseDescriptor() {
  const now = platform.now();
  const onejan = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((now - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
  const weekKey = `${now.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  return {
    id: 'chase-' + weekKey,
    rulesetId: 'chase-weekly-v1',
    name: 'Weekly Score Chase',
    seed: seedFromString('chase:' + weekKey),
    grid: { w: 20, h: 20 },
    food: { count: 4, goldenChance: 0.12 },
    rivals: [{ tier: 'small', length: 3 }, { tier: 'small', length: 2 }, { tier: 'big', length: 5 }],
    obstaclePattern: 'pillars',
    goals: [],
    tickMs: 120, parTicks: 0, maxTicks: 1500,
    mechanics: { allowUndo: false, rivalsEatFood: true },
    themeId: 'meadow',
  };
}

function showSetup(flow) {
  // flow: { mode, descriptor } (+ setupState.options for practice)
  setupState = setupState && setupState.flow.mode === flow.mode ? setupState : { flow, options: {} };
  const desc = typeof flow.descriptor === 'function' ? flow.descriptor(setupState.options) : flow.descriptor;
  const config = toRulesConfig(desc);
  const ranked = flow.mode !== 'practice' && flow.mode !== 'learn' && !settings.timingAssist;
  const options = [];
  if (flow.mode === 'practice') {
    options.push({
      key: 'difficulty', label: 'Difficulty', value: setupState.options.difficulty || 'steady',
      choices: PRACTICE_DIFFICULTIES.map((d) => [d.id, d.name]),
    });
    options.push({
      key: 'theme', label: 'Garden theme', value: setupState.options.theme || 'meadow',
      choices: THEMES.map((t) => [t.id, t.name]),
    });
  }
  ui.showScreen('setup', {
    title: flow.title || desc.name || 'Set up round',
    subtitle: flow.subtitle || '',
    facts: describeFacts(desc, config),
    ranked,
    durationText: durationText(desc),
    assistsText: settings.timingAssist ? 'Timing assist on' : (desc.mechanics?.allowUndo ? 'Undo allowed' : null),
    options: options.length ? options : null,
    controls: flow.mode === 'learn' ? null : steeringHints(),
    suggestLearn: flow.mode !== 'learn' && !Object.values(progression.tutorials || {}).some((t) => t?.done)
      && !Object.values(progression.stages || {}).some((st) => st?.attempts),
  });
}

/** Short onboarding lines shown on every setup screen before the countdown. */
function steeringHints() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const b = settings.bindings || {};
  const keys = (a) => (b[a] || []).map((k) => k.replace('Arrow', '')).join('/');
  return [
    coarse
      ? 'Steer with the on-screen pad, a swipe, or by tapping a tile.'
      : `Steer with ${keys('up') || 'W'} ${keys('left') || 'A'} ${keys('down') || 'S'} ${keys('right') || 'D'}, or click a tile.`,
    'The serpent never stops — it keeps sliding forward until you turn it.',
    'Hitting a hedge wall, your own tail or a rival ends the round.',
  ];
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

function startRound(flow) {
  const desc = typeof flow.descriptor === 'function' ? flow.descriptor(setupState?.options || {}) : flow.descriptor;
  const config = toRulesConfig(desc);
  stopSession();
  stopAttract();

  const ranked = flow.mode !== 'practice' && flow.mode !== 'learn' && !settings.timingAssist;
  currentFlow = { ...flow, descriptor: desc, config, ranked };
  lessonTracker = flow.tutorial ? { tutorial: flow.tutorial, actions: 0, events: 0, done: false } : null;
  replaySource = flow.replay || null;

  session = new GameSession({
    config,
    mode: flow.mode,
    contentId: desc.id,
    rulesetId: desc.rulesetId || 'local-v1',
    tickScale: settings.timingAssist ? 1.25 : 1,
    onEvent: onSessionEvent,
  });

  renderer.setQuality(resolveQuality());
  renderer.loadArena(config, themedFor(desc));
  renderer.prewarm();
  ui.showScreen(null);
  navStack = [];
  ui.setHudVisible(true);
  ui.showPause(false);
  lastHudTick = -1;

  if (flow.tutorial) {
    ui.toast(flow.tutorial.text);
    ui.announce(flow.tutorial.text);
  }
  audio.unlock();
  audio.startAmbience(themeById(desc.themeId).ambience);
  audio.startMusic(flow.mode === 'practice' ? 0.3 : 0.55);
  platform.presenceStart(() => 'playing');
  session.start(settings.reducedMotion ? 1.2 : 3);
}

function stopSession() {
  if (session) { session.destroy(); session = null; }
  currentFlow = null;
  lessonTracker = null;
  replaySource = null;
  ui.showPause(false);
}

function startAttract() {
  if (attract || !renderer) return;
  const desc = practiceConfig('relaxed', THEMES[Math.floor(Math.random() * THEMES.length)].id);
  const config = toRulesConfig(desc);
  attract = { session: null, config, rng: createRng((Math.random() * 1e9) >>> 0) };
  attract.session = new GameSession({ config, mode: 'attract', contentId: 'attract', onEvent: () => {} });
  renderer.setQuality(resolveQuality());
  renderer.loadArena(config, themeById(desc.themeId));
  attract.session.start(0.5);
}

function stopAttract() {
  if (attract) { attract.session.destroy(); attract = null; }
}

function steer(dir) {
  if (!session || session.phase !== 'active' || session.paused) return;
  if (replaySource) return; // watching a replay
  session.dispatch(dir);
}

function onSessionEvent(e) {
  switch (e.type) {
    case 'countdown':
      ui.countdown(e.value);
      if (e.value > 0) audio.play('countdown', { value: e.value });
      else { audio.play('go'); ui.countdown(null); }
      break;
    case 'go': ui.countdown(null); break;
    case 'input-ack': audio.play('turn'); renderer.playEvent({ type: 'turn' }); haptic(8); break;
    case 'turn': break;
    case 'invalid':
      ui.toast(e.reason || 'That move is not legal.', 'warn');
      audio.play('invalid');
      renderer.playEvent({ type: 'invalid' });
      break;
    case 'eat':
      audio.play(e.kind === 'golden' ? 'eat-golden' : 'eat');
      renderer.playEvent(e);
      haptic(12);
      trackLessonEvent('eat');
      break;
    case 'grow': renderer.playEvent(e); break;
    case 'rival-defeated':
      audio.play('rival-defeated');
      renderer.playEvent(e);
      haptic(25);
      trackLessonEvent('rival-defeated');
      break;
    case 'undo': audio.play('undo'); renderer.playEvent(e); break;
    case 'pause': onPaused(e.reason); break;
    case 'resume': audio.applySettings(); break;
    case 'death':
      audio.play('death');
      renderer.playEvent(e);
      ui.caption(audio.captionFor('death'));
      haptic([40, 60, 40]);
      break;
    case 'win':
      audio.play('win');
      renderer.playEvent(e);
      ui.caption('Fanfare — objectives complete!');
      haptic([20, 40, 20, 40, 60]);
      break;
    case 'resolved': onResolved(e.results); break;
  }
}

function trackLessonEvent(name) {
  if (!lessonTracker || lessonTracker.done) return;
  const req = lessonTracker.tutorial.require;
  if (req.event === name) {
    lessonTracker.events += 1;
    if (lessonTracker.events >= req.count) lessonTracker.done = true;
  }
  if (lessonTracker.done && session && session.state.status === 'active') {
    session.abandon(); // lesson target met early — wrap up with a results screen
  }
}

function onPaused(reason) {
  // Durable snapshot for crash-safe resume (richer than the session default).
  if (session && currentFlow) {
    saveSnapshot(session.sessionId, JSON.stringify({
      mode: currentFlow.mode,
      contentId: currentFlow.descriptor.id,
      rulesetId: currentFlow.descriptor.rulesetId || 'local-v1',
      themeId: currentFlow.descriptor.themeId || 'meadow',
      descriptorName: currentFlow.descriptor.name || '',
      day: currentFlow.descriptor.day || null,
      descriptor: currentFlow.descriptor,
      initialConfig: session.initialConfig,
      elapsedMs: session.elapsedMs,
      lessonTracker,
      tickScale: settings.timingAssist ? 1.25 : 1,
      state: session.getSnapshot(),
      replay: session.replay,
    }));
  }
  if (reason === 'background') {
    pausedByBackground = true;
  } else {
    ui.showPause(true, { summary: pauseSummary() });
  }
  audio.play('pause');
}

function pauseSummary() {
  if (!session) return '';
  const s = session.state;
  return `Score ${s.score.total} · length ${s.snake.body.length} · tick ${s.tick}`;
}

function haptic(pattern) {
  if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* unsupported */ } }
}

// ---------------------------------------------------------------------------
// Round resolution: results, persistence, achievements, boards
// ---------------------------------------------------------------------------

function onResolved(results) {
  const flow = currentFlow;
  if (!flow) return;
  if (flow.mode === 'replay') {
    setTimeout(() => showResults(replaySource.resultsCache, { isReplay: true }), 600);
    return;
  }
  flow.lastResults = results;

  progression.totalRounds += 1;
  const newlyUnlocked = [];

  // Mode-specific persistence
  if (flow.mode === 'journey' && results.won) {
    const id = flow.descriptor.id;
    const rec = progression.stages[id] || { attempts: 0 };
    rec.won = true;
    rec.bestScore = Math.max(rec.bestScore || 0, results.score.total);
    rec.bestTicks = rec.bestTicks ? Math.min(rec.bestTicks, results.ticks) : results.ticks;
    progression.stages[id] = rec;
    progression.masteryPoints += flow.descriptor.kind === 'mastery' ? 10 : 2;
    if (unlockAchievement('first-clear')) newlyUnlocked.push(ACHIEVEMENTS[0]);
    if (id === 'j30' && unlockAchievement('grand-milestone')) newlyUnlocked.push(ACHIEVEMENTS[3]);
  } else if (flow.mode === 'journey') {
    const id = flow.descriptor.id;
    const rec = progression.stages[id] || {};
    rec.attempts = (rec.attempts || 0) + 1;
    progression.stages[id] = rec;
  }

  if (flow.mode === 'learn' && lessonTracker) {
    const t = lessonTracker.tutorial;
    const passed = lessonPassed(lessonTracker, results);
    results.lessonPassed = passed;
    if (passed) {
      progression.tutorials[t.id] = { done: true };
      telemetry('tutorial-step', { id: t.id, done: true });
      const allDone = TUTORIALS.every((x) => progression.tutorials[x.id]?.done);
      if (allDone && unlockAchievement('mechanic-mastery')) newlyUnlocked.push(ACHIEVEMENTS[1]);
    }
  }

  if (flow.mode === 'daily') {
    const day = flow.descriptor.day;
    const entry = boardEntryFromResults(results, profile.displayName, true);
    const prev = boards.daily[day];
    if (!prev || compareResults(entry, prev) < 0) boards.daily[day] = entry;
    // streak
    if (progression.lastDailyDay !== day) {
      const yesterday = new Date(platform.now().getTime() - 86400000).toISOString().slice(0, 10);
      progression.currentStreakDays = progression.lastDailyDay === yesterday ? progression.currentStreakDays + 1 : 1;
      progression.lastDailyDay = day;
      progression.dailiesPlayed[day] = { score: results.score.total, won: results.won };
      if (progression.currentStreakDays >= 3 && unlockAchievement('daily-streak-3')) newlyUnlocked.push(ACHIEVEMENTS[2]);
    }
    if (flow.ranked) submitDailyScore(results);
  }

  if (flow.mode === 'chase' && flow.ranked) {
    const entry = boardEntryFromResults(results, profile.displayName, true);
    boards.chase = boards.chase || [];
    boards.chase.push(entry);
    boards.chase.sort(compareResults);
    boards.chase = boards.chase.slice(0, 20);
  }

  if (flow.mode === 'challenge' && results.won) {
    const id = flow.descriptor.id;
    const prev = boards.challenges[id];
    const entry = boardEntryFromResults(results, profile.displayName, true);
    if (!prev || compareResults(entry, prev) < 0) boards.challenges[id] = entry;
  }

  if (progression.totalRounds >= 50 && unlockAchievement('seasoned-gardener')) newlyUnlocked.push(ACHIEVEMENTS[4]);

  saveProgression(progression);
  saveBoards(boards);
  syncCloudSave();
  clearSnapshot();
  telemetry('round-end', { mode: flow.mode, won: results.won, score: results.score.total });

  setTimeout(() => showResults(results, { newlyUnlocked }), settings.reducedMotion ? 300 : 1100);
}

function lessonPassed(tracker, results) {
  const req = tracker.tutorial.require;
  if (req.goal) return results.won;
  if (req.action) return tracker.actions >= req.count;
  if (req.event) return tracker.events >= req.count || results.won;
  return results.won;
}

function unlockAchievement(key) {
  if (progression.achievements[key]) return false;
  progression.achievements[key] = { at: Date.now() };
  return true;
}

async function submitDailyScore(results) {
  if (platform.hosted) return; // platform boards are script-owned/read-only; the daily best is a cloud-synced personal record
  const flow = currentFlow || {};
  const payload = {
    contentVersion: 1, rulesetId: results.rulesetId, seed: results.seed,
    day: flow.descriptor?.day, sessionId: results.sessionId,
    settings: { tickScale: settings.timingAssist ? 1.25 : 1 },
    inputLog: results.replay.commands, score: results.score,
    checksum: results.replay.result.finalHash, durationMs: results.elapsedMs,
  };
  try {
    const res = await platform.submitScore(payload);
    if (res.casual) ui.toast('Offline — score saved locally (casual board).');
  } catch (e) {
    ui.toast(e.code === 'rate-limited' ? 'Score submission rate-limited; saved locally.' : 'Score saved locally; will submit when online.');
  }
}

function showResults(results, extra = {}) {
  const flow = currentFlow || {};
  const won = results.won;
  const lessonPassed = flow.mode === 'learn' && !!results.lessonPassed;
  const displayWon = won || lessonPassed;
  const headline = extra.isReplay ? 'Replay'
    : lessonPassed ? 'Lesson complete!'
    : (won ? 'Garden cleared!' : 'The garden wins');
  let nextAction = 'restart';
  let nextLabel = 'Play again';
  if (flow.mode === 'journey' && won) {
    const idx = JOURNEY_STAGES.findIndex((s) => s.id === flow.descriptor.id);
    if (idx >= 0 && idx + 1 < JOURNEY_STAGES.length) { nextAction = 'next-stage'; nextLabel = 'Next stage →'; }
  } else if (lessonPassed) {
    const idx = TUTORIALS.findIndex((t) => t.id === flow.tutorial.id);
    if (idx >= 0 && idx + 1 < TUTORIALS.length) { nextAction = 'next-lesson'; nextLabel = 'Next lesson →'; }
  }

  const comparison = buildComparison(results, flow);
  ui.showScreen('results', {
    title: 'Results',
    autofocus: '1',
    won: displayWon,
    headline,
    reasonText: extra.isReplay ? 'Watching the recorded round.'
      : lessonPassed && results.reason === 'abandoned' ? 'Lesson target met — nicely done.'
      : (REASON_TEXT[results.reason] || ''),
    score: results.score,
    metaText: `${results.ticks} ticks · ${(results.elapsedMs / 1000).toFixed(1)}s · ${results.invalidActions} invalid move${results.invalidActions === 1 ? '' : 's'} · seed 0x${results.seed.toString(16)} · build ${BUILD_VERSION}`,
    achievements: (extra.newlyUnlocked || []).map((a) => `${a.name} — ${a.desc}`),
    comparison,
    progressText: `Rounds played: ${progression.totalRounds} · Mastery ${progression.masteryPoints}`,
    nextAction, nextLabel,
    canReplay: !extra.isReplay && !!results.replay,
  });
  ui.announce(`${headline}. Total score ${results.score.total}.`, true);
  if (extra.newlyUnlocked?.length) audio.play('achievement');
}

function buildComparison(results, flow) {
  if (flow.mode === 'daily' || flow.mode === 'chase') {
    const config = flow.config;
    const ghosts = ghostEntries(config, flow.descriptor.rulesetId || 'local-v1');
    const me = boardEntryFromResults(results, profile.displayName, true);
    const all = [...ghosts, me].sort(compareResults);
    const rank = all.findIndex((e) => e.me) + 1;
    return `You placed #${rank} of ${all.length} against the garden spirits${flow.ranked ? '' : ' (unranked round)'}.`;
  }
  if (flow.mode === 'journey') {
    const rec = progression.stages[flow.descriptor.id];
    if (rec?.bestScore) return `Stage best: ${rec.bestScore}.`;
  }
  return null;
}

// Replay viewing: deterministic re-simulation of the recorded command log.
function watchReplay() {
  if (!currentFlow || !currentFlow.lastResults?.replay) return;
  const replay = currentFlow.lastResults.replay;
  replay.resultsCache = currentFlow.lastResults;
  replay.originalFlow = { ...currentFlow, replay: null };
  startRound({ ...currentFlow, mode: 'replay', replay });
}

// ---------------------------------------------------------------------------
// Frame loop: feed renderer, update HUD, drive attract mode + replays + gamepad
// ---------------------------------------------------------------------------

function frame() {
  requestAnimationFrame(frame);
  pollGamepad();
  if (attract && !session) {
    driveAttract();
    renderer.syncSnapshot(attract.session.getSnapshot(), attract.session.getAlpha());
    return;
  }
  if (!session) return;
  if (replaySource) driveReplay();
  renderer.syncSnapshot(session.getSnapshot(), session.getAlpha());
  if (session.state.tick !== lastHudTick) {
    lastHudTick = session.state.tick;
    updatePlayHud();
  }
}

function driveAttract() {
  const s = attract.session;
  if (s.state.status !== 'active') {
    if (s.phase === 'done') { stopAttract(); startAttract(); }
    return;
  }
  const state = s.state;
  const head = state.snake.body[0];
  const safe = getSafeTurns(state).map((a) => a.dir);
  const food = nearestFood(state, head);
  if (food && nextFloat(attract.rng) < 0.8) {
    const want = Math.abs(food.x - head.x) > Math.abs(food.y - head.y)
      ? (food.x > head.x ? 'right' : 'left')
      : (food.y > head.y ? 'down' : 'up');
    if (safe.includes(want)) s.dispatch(want);
    else if (safe.length && nextFloat(attract.rng) < 0.2) s.dispatch(safe[nextInt(attract.rng, safe.length)]);
  } else if (safe.length && nextFloat(attract.rng) < 0.1) {
    s.dispatch(safe[nextInt(attract.rng, safe.length)]);
  }
}

function driveReplay() {
  if (!replaySource || session.state.status !== 'active') return;
  const cmds = replaySource.commands;
  if (replaySource._cursor == null) replaySource._cursor = 0;
  while (replaySource._cursor < cmds.length && cmds[replaySource._cursor].tick <= session.state.tick + 1) {
    session.dispatch(cmds[replaySource._cursor].dir);
    replaySource._cursor += 1;
  }
}

function updatePlayHud() {
  const s = session.state;
  let goals = s.goals;
  if (currentFlow.mode === 'learn' && lessonTracker) {
    const req = lessonTracker.tutorial.require;
    goals = [{
      kind: 'lesson', done: lessonTracker.done,
      progress: req.action ? lessonTracker.actions : req.event ? lessonTracker.events : (lessonTracker.done ? 1 : 0),
      count: req.count || 1,
    }];
  }
  const vm = {
    modeLabel: (MODE_LABELS[currentFlow.mode] || '') + (currentFlow.ranked ? '' : ' · unranked') + (currentFlow.descriptor.name ? ' — ' + currentFlow.descriptor.name : ''),
    goals,
    score: s.score.total,
    movesLeft: s.config.moveLimit ? Math.max(0, s.config.moveLimit - s.stats.commands) : null,
    timeLeft: s.config.maxTicks ? Math.max(0, Math.ceil((s.config.maxTicks - s.tick) * s.config.tickMs / 1000)) + 's' : null,
    canUndo: session.canUndo(),
    canHint: true,
  };
  ui.updateHUD(vm);
  ui.updateRails({
    title: 'Objective',
    goals,
    parText: s.config.parTicks ? `Par: ${s.config.parTicks} ticks` : null,
    progressionText: `${Object.values(progression.stages).filter((x) => x.won).length}/${JOURNEY_STAGES.length} journey stages`,
    scoreParts: { Food: s.score.food, Growth: s.score.growth, Rivals: s.score.rivals, Survival: s.score.survival, Objectives: s.score.objective },
    statusText: `Length ${s.snake.body.length} · tick ${s.tick}` + (s.rivals.some((r) => r.alive && r.tier === 'big') ? ' · a hunter prowls!' : ''),
  });
  ui.mirror(s);
}

// ---------------------------------------------------------------------------
// Input: keyboard, gamepad, visibility
// ---------------------------------------------------------------------------

function wireGlobalInput() {
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const b = settings.bindings;
    const screenOpen = !!ui.activeScreen;
    const match = (action) => (b[action] || []).includes(e.code);

    if (match('pause')) {
      e.preventDefault();
      if (screenOpen) { goBack(); return; }
      if (session) togglePause();
      return;
    }
    if (screenOpen) return;
    if (!session) return;

    for (const dir of ['up', 'down', 'left', 'right']) {
      if (match(dir)) { e.preventDefault(); steer(dir); noteLessonAction(); return; }
    }
    if (match('undo')) { e.preventDefault(); doUndo(); return; }
    if (match('hint')) { e.preventDefault(); doHint(); return; }
    if (match('cameraReset')) { e.preventDefault(); /* camera springs re-center automatically */ }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (session && (session.phase === 'active' || session.phase === 'countdown') && !session.paused) session.pause('background');
      audio.setDucked(true);
      renderer.setHidden(true);
      platform.presenceStop();
    } else {
      audio.setDucked(false);
      renderer.setHidden(false);
      if (session) platform.presenceStart(() => 'playing');
      if (pausedByBackground && session) {
        pausedByBackground = false;
        const s = session.state;
        ui.showPause(true, {
          summary: `While you were away the garden froze (solo rounds pause). Score ${s.score.total}, length ${s.snake.body.length}, tick ${s.tick} — nothing moved.`,
        });
        ui.announce('Welcome back. The round was paused while you were away.', false);
      }
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderer.resize(), 80);
  });
  window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));

  window.addEventListener('error', (e) => telemetry('error', { category: String(e.message).slice(0, 40) }));
  window.addEventListener('unhandledrejection', () => telemetry('error', { category: 'unhandled-rejection' }));
}

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads && [...pads].find((p) => p && p.connected);
  if (!pad) return;
  const [x, y] = [pad.axes[0] || 0, pad.axes[1] || 0];
  const prev = gamepadState.axes;
  const pressed = (i) => pad.buttons[i] && pad.buttons[i].pressed;
  const wasPressed = (i) => gamepadState.buttons[i];

  // Menu focus navigation with d-pad.
  if (ui.activeScreen) {
    if ((pressed(12) && !wasPressed(12)) || (y < -0.6 && prev[1] >= -0.6)) moveFocus(-1);
    if ((pressed(13) && !wasPressed(13)) || (y > 0.6 && prev[1] <= 0.6)) moveFocus(1);
    if (pressed(0) && !wasPressed(0)) document.activeElement?.click?.();
    if (pressed(1) && !wasPressed(1)) goBack();
  } else if (session && session.phase === 'active' && !session.paused && !replaySource) {
    const dead = 0.45;
    let dir = null;
    if (pressed(12) || y < -dead) dir = 'up';
    else if (pressed(13) || y > dead) dir = 'down';
    else if (pressed(14) || x < -dead) dir = 'left';
    else if (pressed(15) || x > dead) dir = 'right';
    if (dir && dir !== gamepadState.lastDir) { steer(dir); noteLessonAction(); }
    gamepadState.lastDir = dir;
    if (pressed(1) && !wasPressed(1)) doUndo();
    if (pressed(0) && !wasPressed(0)) doHint();
  }
  if (pressed(9) && !wasPressed(9)) {
    if (ui.activeScreen) goBack();
    else if (session) togglePause();
  }
  gamepadState.axes = [x, y];
  gamepadState.buttons = pad.buttons.map((b) => b.pressed);
}

function moveFocus(delta) {
  const screen = document.querySelector('.screen.active');
  if (!screen) return;
  const items = [...screen.querySelectorAll('button, input, select, [tabindex]')].filter((n) => !n.disabled && n.offsetParent !== null);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = items[(i + delta + items.length) % items.length];
  next.focus();
}

function togglePause() {
  if (!session) return;
  if (session.paused) {
    session.resume();
    ui.showPause(false);
  } else if (session.phase === 'active' || session.phase === 'countdown') {
    session.pause('user');
  }
}

function doUndo() {
  if (session && session.undo()) ui.toast('Stepped back.');
  else if (session && !session.state.config.mechanics.allowUndo) ui.toast('Undo is only available in Practice.', 'warn');
}

function doHint() {
  if (!session || session.state.status !== 'active') return;
  const safe = session.getSafeTurns().map((a) => a.dir);
  renderer.showHint(safe);
  setTimeout(() => renderer.clearHint(), 2500);
  ui.announce(safe.length ? `Safe directions: ${safe.join(', ')}.` : 'No safe direction — brace yourself!');
}

function noteLessonAction() {
  if (!lessonTracker || lessonTracker.done) return;
  const req = lessonTracker.tutorial.require;
  if (req.action) {
    lessonTracker.actions += 1;
    if (lessonTracker.actions >= req.count) {
      lessonTracker.done = true;
      if (session && session.state.status === 'active') session.abandon();
    }
  }
}

// ---------------------------------------------------------------------------
// Action dispatch from UI
// ---------------------------------------------------------------------------

function onAction(name, payload = {}) {
  (window.__actions = window.__actions || []).push(name + '@' + Math.round(performance.now()));
  switch (name) {
    case 'quick-play': {
      const next = JOURNEY_STAGES.find((st, i) =>
        !progression.stages[st.id]?.won && (i === 0 || progression.stages[JOURNEY_STAGES[i - 1].id]?.won));
      if (next) showSetup({ mode: 'journey', descriptor: next, title: `Stage ${next.index}: ${next.name}` });
      else showSetup({ mode: 'practice', descriptor: (o) => practiceConfig(o.difficulty || 'steady', o.theme), title: 'Practice' });
      break;
    }
    case 'nav-modes': navigate('modes'); showNavScreen('modes'); break;
    case 'nav-journey': navigate('journey'); showJourney(); break;
    case 'nav-progression': navigate('progression'); showProgression(); break;
    case 'nav-boards': navigate('boards'); showBoards(); break;
    case 'nav-profile': navigate('profile'); showProfile(); break;
    case 'nav-help': if (session && !session.paused && (session.phase === 'active' || session.phase === 'countdown')) session.pause('user'); navigate('help'); showNavScreen('help'); break;
    case 'nav-settings': if (session && !session.paused && (session.phase === 'active' || session.phase === 'countdown')) session.pause('user'); navigate('settings'); showNavScreen('settings'); break;
    case 'mode-learn': navigate('learn'); showLearn(); break;
    case 'mode-journey': navigate('journey'); showJourney(); break;
    case 'mode-challenge': navigate('challenges'); showChallenges(); break;
    case 'mode-daily': dailyPlay(); break;
    case 'mode-practice': showSetup({ mode: 'practice', descriptor: (o) => practiceConfig(o.difficulty || 'steady', o.theme || 'meadow'), title: 'Practice', subtitle: 'Undo available. Unranked — experiment freely.' }); break;
    case 'mode-chase': showSetup({ mode: 'chase', descriptor: chaseDescriptor(), title: 'Weekly Score Chase', subtitle: 'Same garden all week for everyone. One long run.' }); break;
    case 'daily-play': dailyPlay(); break;
    case 'select-stage': {
      const st = stageById(payload.id);
      if (st) showSetup({ mode: 'journey', descriptor: st, title: `Stage ${st.index}: ${st.name}`, subtitle: st.teaches ? `New concept: ${st.teaches}` : '' });
      break;
    }
    case 'select-tutorial': {
      const t = TUTORIALS.find((x) => x.id === payload.id);
      if (!t) break;
      const desc = { id: t.id, name: t.name, seed: seedFromString(t.id), themeId: 'meadow', mechanics: { allowUndo: false, rivalsEatFood: true }, ...t.config };
      startRound({ mode: 'learn', descriptor: desc, tutorial: t, title: t.name });
      break;
    }
    case 'select-challenge': {
      const c = CHALLENGES.find((x) => x.id === payload.id);
      if (c) showSetup({ mode: 'challenge', descriptor: { ...c, rulesetId: 'challenge-v1' }, title: c.name, subtitle: c.desc });
      break;
    }
    case 'setup-option':
      setupState.options[payload.key] = payload.value;
      showSetup(setupState.flow);
      break;
    case 'start-setup':
      startRound(setupState.flow);
      break;
    case 'steer': steer(payload.dir); noteLessonAction(); break;
    case 'pause': togglePause(); break;
    case 'resume': if (session) { session.resume(); ui.showPause(false); } break;
    case 'restart':
      if (currentFlow?.mode === 'replay' && replaySource?.originalFlow) {
        telemetry('retry', { mode: replaySource.originalFlow.mode });
        startRound(replaySource.originalFlow);
      } else if (currentFlow) {
        telemetry('retry', { mode: currentFlow.mode });
        startRound({ ...currentFlow, replay: null });
      }
      break;
    case 'quit': stopSession(); clearSnapshot(); audio.stopMusic(); audio.stopAmbience(); platform.presenceStop(); goTitle(); break;
    case 'undo': doUndo(); break;
    case 'hint': doHint(); break;
    case 'next-stage': {
      const idx = JOURNEY_STAGES.findIndex((s) => s.id === currentFlow.descriptor.id);
      const next = JOURNEY_STAGES[idx + 1];
      if (next) showSetup({ mode: 'journey', descriptor: next, title: `Stage ${next.index}: ${next.name}` });
      break;
    }
    case 'next-lesson': {
      const idx = TUTORIALS.findIndex((t) => t.id === currentFlow.tutorial.id);
      const next = TUTORIALS[idx + 1];
      if (next) onAction('select-tutorial', { id: next.id });
      break;
    }
    case 'watch-replay': watchReplay(); break;
    case 'back': goBack(); break;
    case 'close-screen': break;
    case 'settings-changed': {
      Object.assign(settings, payload.settings);
      saveSettings(settings);
      ui.applySettings(settings);
      audio.applySettings();
      renderer.setQuality(resolveQuality());
      telemetry('settings-change', {});
      break;
    }
    case 'rebind': {
      const keys = settings.bindings[payload.action] || [];
      if (!keys.includes(payload.key)) keys[0] = payload.key;
      settings.bindings[payload.action] = keys;
      saveSettings(settings);
      showNavScreen('settings');
      ui.toast(`Bound ${payload.action} to ${payload.key.replace('Arrow', '')}.`);
      break;
    }
    case 'profile-save':
      if (!platform.hosted) {
        profile.displayName = String(payload.profile.displayName || 'Guest Gardener').slice(0, 24) || 'Guest Gardener';
        saveProfile(profile);
        ui.updateTopbar(topbarVM());
      }
      goBack();
      break;
    case 'equip-cosmetic': {
      const c = COSMETICS.find((x) => x.id === payload.id);
      if (!c) break;
      if (!progression.cosmetics.unlocked.includes(c.id)) {
        if (progression.masteryPoints < c.cost) { ui.toast(`Needs ${c.cost} mastery points.`, 'warn'); break; }
        progression.cosmetics.unlocked.push(c.id);
      }
      progression.cosmetics.equipped.trail = c.id;
      saveProgression(progression);
      syncCloudSave();
      showProgression();
      break;
    }
    case 'resume-snapshot': resumeSnapshot(); break;
    case 'discard-snapshot': clearSnapshot(); goTitle(); break;
    case 'replay-tutorials': progression.tutorials = {}; saveProgression(progression); syncCloudSave(); navigate('learn'); showLearn(); break;
  }
}

function dailyPlay() {
  const desc = dailyConfig(platform.now());
  showSetup({
    mode: 'daily', descriptor: desc,
    title: 'Daily Garden — ' + desc.day,
    subtitle: platform.hosted
      ? 'One shared seed for everyone today. Personal best syncs to your account.'
      : 'One shared seed for everyone today. Ranked.',
  });
}

function dailyLabel() {
  const day = dailyConfig(platform.now()).day;
  const played = progression.dailiesPlayed[day];
  return played ? `Daily ✓ (best ${played.score})` : 'Daily challenge';
}

function updateDailyChip() {
  ui.updateTopbar(topbarVM());
  setInterval(() => ui.updateTopbar(topbarVM()), 30000);
}

function topbarVM() {
  const now = platform.now();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const mins = Math.max(0, Math.round((next - now) / 60000));
  const day = dailyConfig(now).day;
  const played = progression.dailiesPlayed[day];
  return {
    profileName: profile.displayName,
    dailyText: `${played ? '✓' : '◷'} Daily · next in ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m${platform.hosted ? '' : ' (local time)'}`,
  };
}

function snapshotLabel(snap) {
  try {
    const data = JSON.parse(snap.state);
    const st = data.state;
    return `${MODE_LABELS[data.mode] || 'Round'} · score ${st.score.total} · length ${st.snake.body.length} · saved ${new Date(snap.at).toLocaleTimeString()}`;
  } catch { return 'A previous round can be resumed.'; }
}

function resumeSnapshot() {
  const snap = loadSnapshot();
  if (!snap) { goTitle(); return; }
  try {
    const data = JSON.parse(snap.state);
    stopAttract();
    const tutorial = data.mode === 'learn' ? TUTORIALS.find(t => t.id === data.contentId) : null;
    const descriptor = data.descriptor ||
      (data.mode === 'daily' && data.day ? dailyConfig(new Date(data.day + 'T00:00:00Z')) : null) ||
      stageById(data.contentId) || CHALLENGES.find(c => c.id === data.contentId) ||
      (tutorial ? { id: tutorial.id, name: tutorial.name, seed: seedFromString(tutorial.id), themeId: 'meadow', mechanics: { allowUndo: false, rivalsEatFood: true }, ...tutorial.config } : null);
    if (!descriptor && !data.initialConfig) throw new Error('Legacy snapshot has no reproducible configuration');
    const config = data.initialConfig || toRulesConfig(descriptor);
    session = GameSession.fromSnapshot({
      config, tickScale: data.tickScale || 1,
      mode: data.mode, contentId: data.contentId, rulesetId: data.rulesetId,
      onEvent: onSessionEvent,
    }, JSON.stringify(data.state), data.replay);
    session.elapsedMs = Number.isFinite(data.elapsedMs) ? data.elapsedMs : data.state.tick * session.tickMs;
    currentFlow = { mode: data.mode, descriptor, config, tutorial,
      ranked: data.mode !== 'practice' && data.mode !== 'learn' && (data.tickScale || 1) === 1 };
    lessonTracker = tutorial ? { tutorial, actions: data.lessonTracker?.actions || 0,
      events: data.lessonTracker?.events || 0, done: !!data.lessonTracker?.done } : null;
    replaySource = null;
    renderer.setQuality(resolveQuality());
    renderer.loadArena(session.initialConfig, themeById(data.themeId || 'meadow'));
    ui.showScreen(null);
    ui.setHudVisible(true);
    audio.unlock();
    session.start(1.5);
    ui.toast('Round restored from your last safe snapshot.');
  } catch (err) {
    console.warn('snapshot restore failed:', err);
    telemetry('error', { category: 'snapshot-restore' });
    clearSnapshot();
    ui.toast('That snapshot could not be restored.', 'warn');
    goTitle();
  }
}

// Debug/inspection handle (no privileged data; used by smoke tests).
window.__sq = {
  get session() { return session; },
  get settings() { return settings; },
  get renderer() { return renderer; },
};

boot();
