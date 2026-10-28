// Serpent Quest on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js)
// and session (js/session.js: countdown, fixed ticks, undo, replay envelope,
// results) are the browser build's, unchanged in what they decide; this
// module is what js/main.js did around them — the screen flow (title with the
// attract garden behind it → modes → setup → countdown → playing ⇄ paused →
// results), every mode (Learn, Journey, Daily, Practice, Challenge, Score
// chase, replays), resuming an interrupted round, the session's events
// (sounds, bursts, captions, haptics, lesson tracking), steering by keys,
// pads, the on-screen pad, swipes and taps, hints, undo, the results with
// progression, achievements, local boards against the garden spirits and the
// Score chase post to the high-score leaderboard, and the lifecycle (a hidden
// window pauses the round, as visibilitychange did). Screens are drawn by
// screens.ts (starhermit:ui), the arena by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the session advances 1000/60 ms a step
// (the browser build read performance.now() every animation frame), and the
// attract garden, replays and the short delays (results, hints, toasts,
// captions) run on the same clock, so a hidden window and slow frames never
// move them and play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  BUILD_VERSION, Content, GameSession, Progress, Rng, Rules, type BoardEntry, type Descriptor, type Dir, type GameEvent, type Results,
  type RulesConfig, type Session, type State, type Tutorial,
} from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T, pname } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

// ------------------------------------------------------------------ static declarations (main.js)
export const ACHIEVEMENTS = [
  { key: "first-clear", name: N("First Bloom"), desc: N("Complete your first journey stage.") },
  { key: "mechanic-mastery", name: N("Garden Scholar"), desc: N("Complete every lesson in Learn mode.") },
  { key: "daily-streak-3", name: N("Three Sunrises"), desc: N("Play the daily challenge three days in a row.") },
  { key: "grand-milestone", name: N("Crucible Clearer"), desc: N("Clear journey stage 30, Mastery: Crucible.") },
  { key: "seasoned-gardener", name: N("Seasoned Gardener"), desc: N("Finish 50 rounds of Serpent Quest.") },
];
export const COSMETICS = [
  { id: "trail-leaf", name: N("Leaf Scales"), cost: 0, tint: null as number | null },
  { id: "trail-petal", name: N("Petal Scales"), cost: 30, tint: 0xd96a9a },
  { id: "trail-spark", name: N("Sunspark Scales"), cost: 60, tint: 0xd9a83c },
  { id: "trail-frost", name: N("Frost Scales"), cost: 100, tint: 0x5a9ad9 },
];
export const REASON_TEXT: Record<string, string> = {
  "crashed-wall": N("The hedge wall wins this round."), "crashed-self": N("Tangled in your own coils."),
  "crashed-obstacle": N("A rock ended that path."), "eaten-by-rival": N("A hunter caught your serpent."),
  "moves-exhausted": N("Out of moves."), "time-up": N("Time ran out."), abandoned: N("Round left unfinished."),
};
const MODE_LABELS: Record<string, string> = { learn: N("Lesson"), journey: N("Journey"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge"), chase: N("Score chase"), replay: N("Replay") };
export const modeLabel = (mode: string): string => (MODE_LABELS[mode] ? T(MODE_LABELS[mode]!) : "");
export const DIR_NAMES: Record<Dir, string> = { up: N("up"), down: N("down"), left: N("left"), right: N("right") };
export const TEACHES: Record<string, string> = {
  steer: N("steering"), length: N("growing long"), hunt: N("hunting prey"), threat: N("hunters"),
  golden: N("golden berries"), speed: N("speed"), endure: N("endurance"),
};

// ------------------------------------------------------------------ application state
export type ScreenName = "title" | "modes" | "journey" | "learn" | "challenges" | "setup" | "results" | "help" | "settings" | "progression" | "profile" | "boards";
export interface Flow {
  mode: string; title?: () => string; subtitle?: () => string;
  descriptor: Descriptor | ((o: Record<string, string>) => Descriptor);
  tutorial?: Tutorial; replay?: ReplaySource | null;
}
export interface CurrentFlow extends Flow { descriptor: Descriptor; config: RulesConfig; ranked: boolean; lastResults?: Results; lb?: platform.Posted | "posting" | null }
interface ReplaySource { commands: { tick: number; dir: Dir }[]; cursor: number; resultsCache: Results; originalFlow: CurrentFlow }
export interface ResultsView {
  results: Results; isReplay: boolean; newlyUnlocked: typeof ACHIEVEMENTS; headline: string; won: boolean; reasonText: string;
  comparison: string | null; nextAction: "restart" | "next-stage" | "next-lesson"; nextLabel: string; canReplay: boolean;
}

export const app = {
  screen: "title" as ScreenName | null,
  /** Screens opened over the current one (main.js navStack). */
  navStack: [] as ScreenName[],
  openedFrame: 0,
  focusNext: null as string | null,
  setup: null as { flow: Flow; options: Record<string, string> } | null,
  results: null as ResultsView | null,
  boardsTab: 0,
  /** The pause card (with its summary) or null. */
  pause: null as { summary: () => string } | null,
  /** The compact layout's rail drawer. */
  drawer: null as "left" | "right" | null,
  countdown: null as { text: string; at: number } | null,
  toast: null as { text: string; warn: boolean; until: number } | null,
  caption: null as { text: string; until: number } | null,
  hintUntil: 0,
};
export let session: Session | null = null;
export let currentFlow: CurrentFlow | null = null;
let attract: { session: Session; rng: { state: number } } | null = null;
let lessonTracker: { tutorial: Tutorial; actions: number; events: number; done: boolean } | null = null;
let replaySource: ReplaySource | null = null;
let pausedByBackground = false;
let clockMs = 0;
const timers: { at: number; fn: () => void }[] = [];
function after(ms: number, fn: () => void): void { timers.push({ at: clockMs + ms, fn }); }
export const now = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;
export const progression = () => platform.save().progression;
export const boards = () => platform.save().boards;

// ------------------------------------------------------------------ helpers
let pendingAnnounce: { text: string; assertive: boolean } | null = null;
/** At most one announcement a frame: the newest wins, an assertive one over a polite one (flushed in onRender). */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  if (pendingAnnounce && pendingAnnounce.assertive && !assertive) return;
  pendingAnnounce = { text: text.slice(0, 500), assertive };
}
export function toast(text: string, kind = ""): void {
  app.toast = { text, warn: kind === "warn", until: clockMs + 2600 };
  if (kind === "warn") announce(text, true);
}
function caption(text: string): void {
  if (!text || !platform.options.captions) { app.caption = null; return; }
  app.caption = { text, until: clockMs + 2200 };
}
function haptic(pattern: number | number[]): void {
  if (!platform.options.haptics) return;
  const ms = Array.isArray(pattern) ? pattern.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) : pattern;
  try { vibrate(ms); } catch { /* no motor */ }
}
export function playing(): boolean { return !!session && session.phase === "active" && !session.paused && !replaySource && app.screen === null; }
export function inRound(): boolean { return !!session && (session.phase === "active" || session.phase === "countdown"); }
export function isReplay(): boolean { return !!replaySource; }

// ------------------------------------------------------------------ navigation (main.js)
export function openScreen(name: ScreenName | null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.drawer = null;
  ui.setFocus(null);
}
export function goTitle(): void {
  app.navStack = [];
  stopSession();
  startAttract();
  openScreen("title");
  app.focusNext = platform.save().snapshot ? "btn-resume-snapshot" : "btn-play";
}
/** main.js navigate(): remember the screen a new one opens over. */
export function navigate(name: ScreenName): void {
  if (app.screen && app.screen !== name) app.navStack.push(app.screen);
  openScreen(name);
}
export function goBack(): void {
  audio.play("ui-back");
  const prev = app.navStack.pop();
  if (prev) { openScreen(prev); return; }
  if (session && session.phase !== "done") { openScreen(null); return; } // return to the paused round
  goTitle();
}
/** Help / Settings from the top bar mid-round pause it first (main.js nav-help / nav-settings). */
export function openOverRound(name: ScreenName): void {
  if (session && !session.paused && inRound()) session.pause("user");
  navigate(name);
}

// ------------------------------------------------------------------ descriptors (main.js)
export function themedFor(desc: Descriptor) {
  const base = Content.themeById(desc.themeId);
  const cosmetic = COSMETICS.find((c) => c.id === progression().cosmetics.equipped.trail);
  if (cosmetic && cosmetic.tint != null) return { ...base, snakeHead: cosmetic.tint, snakeBody: cosmetic.tint };
  return base;
}
export function chaseDescriptor(): Descriptor {
  const nowD = new Date(platform.nowMs());
  const onejan = new Date(Date.UTC(nowD.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((nowD.getTime() - onejan.getTime()) / 86400000) + onejan.getUTCDay() + 1) / 7);
  const weekKey = `${nowD.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  return {
    id: "chase-" + weekKey, rulesetId: "chase-weekly-v1", name: N("Weekly Score Chase"), seed: Rng.seedFromString("chase:" + weekKey),
    grid: { w: 20, h: 20 }, food: { count: 4, goldenChance: 0.12 },
    rivals: [{ tier: "small", length: 3 }, { tier: "small", length: 2 }, { tier: "big", length: 5 }],
    obstaclePattern: "pillars", goals: [], tickMs: 120, parTicks: 0, maxTicks: 1500,
    mechanics: { allowUndo: false, rivalsEatFood: true } as { allowUndo: boolean }, themeId: "meadow",
  };
}
export function dailyDescriptor(): Descriptor { return Content.dailyConfig(new Date(platform.nowMs())); }
function tutorialDescriptor(t: Tutorial): Descriptor {
  return { id: t.id, name: t.name, seed: Rng.seedFromString(t.id), themeId: "meadow", mechanics: { allowUndo: false, rivalsEatFood: true } as { allowUndo: boolean }, ...t.config } as unknown as Descriptor;
}
export function resolveDescriptor(flow: Flow): Descriptor {
  return typeof flow.descriptor === "function" ? flow.descriptor(app.setup?.options ?? {}) : flow.descriptor;
}
export const isRanked = (mode: string): boolean => mode !== "practice" && mode !== "learn" && !platform.options.timingAssist;

/** main.js describeFacts. */
export function describeFacts(desc: Descriptor, config: RulesConfig): string[] {
  const facts: string[] = [];
  const goalText: Record<string, string> = { food: N("eat berries ({n})"), length: N("grow long ({n})"), rivals: N("defeat small rivals ({n})"), survive: N("survive ({n})"), score: N("score points ({n})") };
  if (desc.goals?.length) facts.push(T("Goals: {list}", { list: desc.goals.map((g) => (goalText[g.kind] ? T(goalText[g.kind]!, { n: g.count }) : `${g.kind} (${g.count})`)).join(" + ") }));
  else facts.push(T("No set goals — survive and score as much as you can."));
  facts.push(config.obstacles.length ? T("Arena {w}×{h} with obstacles", { w: config.grid.w, h: config.grid.h }) : T("Arena {w}×{h}, open ground", { w: config.grid.w, h: config.grid.h }));
  const small = (desc.rivals || []).filter((r) => r.tier === "small").length;
  const big = (desc.rivals || []).filter((r) => r.tier === "big").length;
  if (small || big) {
    const parts: string[] = [];
    if (small) parts.push(T("{n} prey", { n: small }));
    if (big) parts.push(big > 1 ? T("{n} hunters", { n: big }) : T("{n} hunter", { n: big }));
    facts.push(T("Rivals: {list}", { list: parts.join(", ") }));
  }
  if (desc.moveLimit) facts.push(T("Move limit: {n}", { n: desc.moveLimit }));
  if (desc.maxTicks) facts.push(T("Time cap: {n}s", { n: Math.round((desc.maxTicks * desc.tickMs) / 1000) }));
  const speed = desc.tickMs <= 100 ? N("very fast") : desc.tickMs <= 125 ? N("fast") : desc.tickMs <= 150 ? N("steady") : N("relaxed");
  facts.push(T("Speed: {speed}", { speed: T(speed) }));
  return facts;
}
export function durationText(desc: Descriptor): string {
  const ticks = desc.parTicks || desc.maxTicks || 400;
  return T("~{n} min", { n: Math.max(1, Math.round(Math.round((ticks * desc.tickMs) / 1000) / 60)) });
}
export function showSetup(flow: Flow): void {
  app.setup = app.setup && app.setup.flow.mode === flow.mode ? { flow, options: app.setup.options } : { flow, options: {} };
  if (app.screen !== "setup") navigate("setup");
  app.focusNext = "btn-start";
}

// ------------------------------------------------------------------ rounds (main.js)
export function startRound(flow: Flow): void {
  const desc = resolveDescriptor(flow);
  const config = Content.toRulesConfig(desc);
  stopSession();
  stopAttract();
  currentFlow = { ...flow, descriptor: desc, config, ranked: isRanked(flow.mode) };
  lessonTracker = flow.tutorial ? { tutorial: flow.tutorial, actions: 0, events: 0, done: false } : null;
  replaySource = flow.replay ?? null;
  session = new GameSession({
    config, mode: flow.mode, contentId: desc.id, rulesetId: desc.rulesetId || "local-v1",
    tickScale: platform.options.timingAssist ? 1.25 : 1, onEvent: onSessionEvent,
  });
  render.loadArena(config, themedFor(desc));
  render.setPaused(false);
  app.navStack = [];
  openScreen(null);
  app.pause = null;
  app.results = null;
  app.hintUntil = 0;
  render.showHint(null);
  if (flow.tutorial) { toast(T(flow.tutorial.text)); announce(T(flow.tutorial.text)); }
  audio.setRound({ intensity: flow.mode === "practice" ? 0.3 : 0.55, ambience: Content.themeById(desc.themeId).ambience });
  audio.setSuspended(false);
  session.start(preferences().reducedMotion ? 1.2 : 3);
}
function stopSession(): void {
  if (session) { session.destroy(); session = null; }
  currentFlow = null;
  lessonTracker = null;
  replaySource = null;
  app.pause = null;
  app.countdown = null;
  render.setPaused(false);
}
function startAttract(): void {
  if (attract) return;
  const desc = Content.practiceConfig("relaxed", Content.THEMES[Math.floor(Math.random() * Content.THEMES.length)]!.id);
  const config = Content.toRulesConfig(desc);
  const s = new GameSession({ config, mode: "attract", contentId: "attract", onEvent: () => undefined });
  attract = { session: s, rng: Rng.createRng((Math.random() * 1e9) >>> 0) };
  render.loadArena(config, Content.themeById(desc.themeId));
  audio.setRound(null);
  s.start(0.5);
}
function stopAttract(): void { if (attract) { attract.session.destroy(); attract = null; } }

export function steer(dir: Dir): void {
  if (!session || session.phase !== "active" || session.paused || replaySource) return;
  session.dispatch(dir);
}
/** A steering input from the player (keys, pad, tray, swipe, tap): steers and counts for the steering lesson. */
export function playerSteer(dir: Dir): void {
  if (!playing()) return;
  steer(dir);
  noteLessonAction();
}

function onSessionEvent(e: GameEvent): void {
  switch (e.type) {
    case "countdown":
      if ((e.value ?? 0) > 0) {
        app.countdown = { text: String(e.value), at: clockMs };
        announce(String(e.value));
        audio.play("countdown");
        render.playEvent(e);
      } else { audio.play("go"); app.countdown = { text: T("Go!"), at: clockMs }; after(900, () => { if (app.countdown && session?.phase !== "countdown") app.countdown = null; }); }
      break;
    case "go": render.playEvent(e); break;
    case "input-ack": audio.play("turn"); render.playEvent({ type: "turn", dir: e.dir }); haptic(8); break;
    case "invalid":
      toast(T(e.reason || N("That move is not legal.")), "warn");
      audio.play("invalid");
      render.playEvent(e);
      break;
    case "eat":
      audio.play(e.kind === "golden" ? "eat-golden" : "eat");
      render.playEvent(e);
      haptic(12);
      trackLessonEvent("eat");
      break;
    case "grow": render.playEvent(e); break;
    case "rival-defeated":
      audio.play("rival-defeated");
      render.playEvent(e);
      haptic(25);
      trackLessonEvent("rival-defeated");
      break;
    case "undo": audio.play("undo"); render.playEvent(e); break;
    case "pause": onPaused(e.reason ?? "user"); break;
    case "resume": render.setPaused(false); audio.setSuspended(false); break;
    case "death":
      audio.play("death");
      render.playEvent(e);
      caption(T(audio.CAPTIONS.death!));
      haptic([40, 60, 40]);
      break;
    case "win":
      audio.play("win");
      render.playEvent(e);
      caption(T("Fanfare — objectives complete!"));
      haptic([20, 40, 20, 40, 60]);
      break;
    case "resolved": if (e.results) onResolved(e.results); break;
  }
}
function trackLessonEvent(name: string): void {
  if (!lessonTracker || lessonTracker.done) return;
  const req = lessonTracker.tutorial.require;
  if (req.event === name) {
    lessonTracker.events += 1;
    if (lessonTracker.events >= (req.count ?? 1)) lessonTracker.done = true;
  }
  // lesson target met early — wrap up with a results screen (after the event's own handling)
  if (lessonTracker.done && session && session.state.status === "active") { const s = session; queueMicrotask(() => { if (session === s && s.state.status === "active") s.abandon(); }); }
}
function noteLessonAction(): void {
  if (!lessonTracker || lessonTracker.done) return;
  const req = lessonTracker.tutorial.require;
  if (req.action) {
    lessonTracker.actions += 1;
    if (lessonTracker.actions >= (req.count ?? 1)) {
      lessonTracker.done = true;
      if (session && session.state.status === "active") session.abandon();
    }
  }
}
export function lessonGoal(): { kind: string; done: boolean; progress: number; count: number } | null {
  if (!lessonTracker) return null;
  const req = lessonTracker.tutorial.require;
  return { kind: "lesson", done: lessonTracker.done, progress: req.action ? lessonTracker.actions : req.event ? lessonTracker.events : (lessonTracker.done ? 1 : 0), count: req.count || 1 };
}

function onPaused(reason: string): void {
  // Durable snapshot for crash-safe resume (main.js onPaused, kept in the engine save).
  if (session && currentFlow && currentFlow.mode !== "replay") {
    platform.save().snapshot = {
      sessionId: session.sessionId, at: Date.now(),
      mode: currentFlow.mode, contentId: currentFlow.descriptor.id, rulesetId: currentFlow.descriptor.rulesetId || "local-v1",
      themeId: currentFlow.descriptor.themeId || "meadow", descriptor: currentFlow.descriptor, initialConfig: session.initialConfig,
      elapsedMs: session.elapsedMs, lessonTracker: lessonTracker ? { actions: lessonTracker.actions, events: lessonTracker.events, done: lessonTracker.done } : null,
      tickScale: platform.options.timingAssist ? 1.25 : 1, state: session.getSnapshot(), replay: session.replay,
    } as unknown as Record<string, unknown>;
    platform.persist();
  }
  render.setPaused(true);
  audio.setSuspended(true);
  if (reason === "background") pausedByBackground = true;
  else showPause(pauseSummary);
  audio.play("pause");
}
function showPause(summary: () => string): void {
  app.pause = { summary };
  app.openedFrame = frame().frame;
  app.focusNext = "btn-resume";
}
export function pauseSummary(): string {
  if (!session) return "";
  const s = session.state;
  return T("Score {score} · length {len} · tick {tick}", { score: s.score.total, len: s.snake.body.length, tick: s.tick });
}
export function togglePause(): void {
  if (!session) return;
  if (session.paused) resume();
  else if (inRound()) session.pause("user");
}
export function resume(): void {
  if (!session) return;
  session.resume();
  app.pause = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function doUndo(): void {
  if (!session) return;
  if (session.undo()) toast(T("Stepped back."));
  else if (!session.state.config.mechanics.allowUndo) toast(T("Undo is only available in Practice."), "warn");
}
export function doHint(): void {
  if (!session || session.state.status !== "active") return;
  const safe = session.getSafeTurns().map((a) => a.dir);
  render.showHint(safe);
  app.hintUntil = clockMs + 2500;
  announce(safe.length ? T("Safe directions: {list}.", { list: safe.map((d) => T(DIR_NAMES[d])).join(", ") }) : T("No safe direction — brace yourself!"));
}
export function canUndo(): boolean { return !!session && session.canUndo(); }

// ------------------------------------------------------------------ round resolution (main.js onResolved)
function boardEntryFromResults(r: Results, name: string, me: boolean): BoardEntry {
  return {
    name, me, score: r.score.total, won: r.won, invalidActions: r.invalidActions, elapsedMs: r.elapsedMs, sessionId: r.sessionId,
    ruleset: r.rulesetId, seed: "0x" + r.seed.toString(16), when: new Date(platform.nowMs()).toISOString().slice(0, 10),
  };
}
export function playerName(): string {
  return platform.signedIn() ? platform.displayName() || T("Player") : platform.save().name || "Guest Gardener";
}
function nearestFood(state: State, head: { x: number; y: number }) {
  let best = null, bestD = Infinity;
  for (const f of state.food) { const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y); if (d < bestD) { bestD = d; best = f; } }
  return best;
}
/** main.js ghostRun: the scripted benchmark player (public rules API only). */
function ghostRun(config: RulesConfig, seed: number, skill: number): State {
  const rng = Rng.createRng(seed);
  let s = Rules.createGame(config);
  const cap = (config.maxTicks || 1500) + 50;
  let steps = 0;
  while (s.status === "active" && steps++ < cap) {
    const head = s.snake.body[0]!;
    const legal = Rules.getLegalActions(s).map((a) => a.dir), safe = Rules.getSafeTurns(s).map((a) => a.dir);
    if (!legal.length) break;
    let dir: Dir | undefined;
    const food = nearestFood(s, head);
    if (food && Rng.nextFloat(rng) < skill) {
      const horiz = Math.abs(food.x - head.x) > Math.abs(food.y - head.y);
      const want: Dir = horiz ? (food.x > head.x ? "right" : "left") : (food.y > head.y ? "down" : "up");
      const alt: Dir = horiz ? (food.y > head.y ? "down" : "up") : (food.x > head.x ? "right" : "left");
      dir = [want, alt].find((d) => safe.includes(d)) || safe[0] || legal[0];
    } else dir = safe.length ? safe[Rng.nextInt(rng, safe.length)] : legal[0];
    if (dir && dir !== s.snake.dir) s = Rules.applyCommand(s, { type: "turn", dir }).state;
    s = Rules.advanceTick(s).state;
  }
  return s;
}
/** main.js ghostEntries: the three garden spirits' runs on a board's garden, computed once and kept in the save. */
export function ghostEntries(config: RulesConfig, rulesetId: string): BoardEntry[] {
  const key = "ghost:" + rulesetId + ":" + Rng.hashString(JSON.stringify(config.grid) + config.seed);
  const b = boards();
  b.ghosts = b.ghosts || {};
  if (!b.ghosts[key]) {
    const spirits: [string, number][] = [["Bramble", 0.9], ["Moss", 0.65], ["Thistle", 0.4]];
    b.ghosts[key] = spirits.map(([name, skill], i) => {
      const s = ghostRun(config, Rng.seedFromString(key + name), skill);
      return {
        name: name + " (spirit)", me: false, score: s.score.total, won: s.status === "won", invalidActions: 0, elapsedMs: s.tick * config.tickMs,
        sessionId: "ghost-" + i, ruleset: rulesetId, seed: "0x" + config.seed.toString(16), when: "—",
      };
    });
    platform.persist();
  }
  return b.ghosts[key]!;
}
function unlockAchievement(key: string): boolean {
  const p = progression();
  if (p.achievements[key]) return false;
  p.achievements[key] = { at: Date.now() };
  return true;
}
function onResolved(results: Results): void {
  const flow = currentFlow;
  if (!flow) return;
  if (flow.mode === "replay") {
    const src = replaySource!;
    after(600, () => { if (currentFlow === flow) showResults(src.resultsCache, { isReplay: true }); });
    return;
  }
  flow.lastResults = results;
  flow.lb = null;
  const p = progression(), b = boards();
  p.totalRounds += 1;
  const newly: typeof ACHIEVEMENTS = [];
  const id = flow.descriptor.id;
  if (flow.mode === "journey" && results.won) {
    const rec = p.stages[id] || { attempts: 0 };
    rec.won = true;
    rec.bestScore = Math.max(rec.bestScore || 0, results.score.total);
    rec.bestTicks = rec.bestTicks ? Math.min(rec.bestTicks, results.ticks) : results.ticks;
    p.stages[id] = rec;
    p.masteryPoints += flow.descriptor.kind === "mastery" ? 10 : 2;
    if (unlockAchievement("first-clear")) newly.push(ACHIEVEMENTS[0]!);
    if (id === "j30" && unlockAchievement("grand-milestone")) newly.push(ACHIEVEMENTS[3]!);
  } else if (flow.mode === "journey") {
    const rec = p.stages[id] || {};
    rec.attempts = (rec.attempts || 0) + 1;
    p.stages[id] = rec;
  }
  if (flow.mode === "learn" && lessonTracker) {
    const t = lessonTracker.tutorial;
    const req = t.require;
    const passed = req.goal ? results.won : req.action ? lessonTracker.actions >= (req.count ?? 1) : req.event ? lessonTracker.events >= (req.count ?? 1) || results.won : results.won;
    results.lessonPassed = passed;
    if (passed) {
      p.tutorials[t.id] = { done: true };
      if (Content.TUTORIALS.every((x) => p.tutorials[x.id]?.done) && unlockAchievement("mechanic-mastery")) newly.push(ACHIEVEMENTS[1]!);
    }
  }
  if (flow.mode === "daily") {
    const day = String(flow.descriptor.day);
    const entry = boardEntryFromResults(results, playerName(), true);
    const prev = b.daily[day];
    if (!prev || Progress.compareResults(entry, prev) < 0) b.daily[day] = entry;
    if (p.lastDailyDay !== day) {
      const yesterday = new Date(platform.nowMs() - 86400000).toISOString().slice(0, 10);
      p.currentStreakDays = p.lastDailyDay === yesterday ? p.currentStreakDays + 1 : 1;
      p.lastDailyDay = day;
      p.dailiesPlayed[day] = { score: results.score.total, won: results.won };
      if (p.currentStreakDays >= 3 && unlockAchievement("daily-streak-3")) newly.push(ACHIEVEMENTS[2]!);
    }
  }
  if (flow.mode === "chase" && flow.ranked) {
    // signed in: the run's total goes to the platform high-score board (through score-script.js)
    if (platform.signedIn()) {
      flow.lb = "posting";
      void platform.postScore(results.score.total).then((r) => { flow.lb = r; });
    }
    b.chase.push(boardEntryFromResults(results, playerName(), true));
    b.chase.sort(Progress.compareResults);
    b.chase = b.chase.slice(0, 20);
  }
  if (flow.mode === "challenge" && results.won) {
    const prev = b.challenges[id];
    const entry = boardEntryFromResults(results, playerName(), true);
    if (!prev || Progress.compareResults(entry, prev) < 0) b.challenges[id] = entry;
  }
  if (p.totalRounds >= 50 && unlockAchievement("seasoned-gardener")) newly.push(ACHIEVEMENTS[4]!);
  platform.save().snapshot = null;
  platform.persist();
  after(preferences().reducedMotion ? 300 : 1100, () => { if (currentFlow === flow) showResults(results, { newlyUnlocked: newly }); });
}

function buildComparison(results: Results, flow: CurrentFlow): string | null {
  if (flow.mode === "daily" || flow.mode === "chase") {
    const ghosts = ghostEntries(flow.config, flow.descriptor.rulesetId || "local-v1");
    const all = [...ghosts, boardEntryFromResults(results, playerName(), true)].sort(Progress.compareResults);
    const rank = all.findIndex((e) => e.me) + 1;
    return flow.ranked ? T("You placed #{rank} of {total} against the garden spirits.", { rank, total: all.length })
      : T("You placed #{rank} of {total} against the garden spirits (unranked round).", { rank, total: all.length });
  }
  if (flow.mode === "journey") {
    const rec = progression().stages[flow.descriptor.id];
    if (rec?.bestScore) return T("Stage best: {score}.", { score: rec.bestScore });
  }
  return null;
}
function showResults(results: Results, extra: { isReplay?: boolean; newlyUnlocked?: typeof ACHIEVEMENTS }): void {
  const flow = currentFlow;
  if (!flow) return;
  const isReplayView = !!extra.isReplay;
  const original = isReplayView ? replaySource!.originalFlow : flow;
  const won = results.won;
  const lessonPassed = original.mode === "learn" && !!results.lessonPassed;
  const headline = isReplayView ? T("Replay") : lessonPassed ? T("Lesson complete!") : won ? T("Garden cleared!") : T("The garden wins");
  let nextAction: ResultsView["nextAction"] = "restart";
  let nextLabel = T("Play again");
  if (!isReplayView && original.mode === "journey" && won) {
    const idx = Content.JOURNEY_STAGES.findIndex((s) => s.id === original.descriptor.id);
    if (idx >= 0 && idx + 1 < Content.JOURNEY_STAGES.length) { nextAction = "next-stage"; nextLabel = T("Next stage →"); }
  } else if (!isReplayView && lessonPassed && original.tutorial) {
    const idx = Content.TUTORIALS.findIndex((t) => t.id === original.tutorial!.id);
    if (idx >= 0 && idx + 1 < Content.TUTORIALS.length) { nextAction = "next-lesson"; nextLabel = T("Next lesson →"); }
  }
  app.results = {
    results, isReplay: isReplayView, newlyUnlocked: extra.newlyUnlocked ?? [], headline, won: won || lessonPassed,
    reasonText: isReplayView ? T("Watching the recorded round.") : lessonPassed && results.reason === "abandoned" ? T("Lesson target met — nicely done.")
      : REASON_TEXT[results.reason ?? ""] ? T(REASON_TEXT[results.reason ?? ""]!) : "",
    comparison: isReplayView ? null : buildComparison(results, flow), nextAction, nextLabel,
    canReplay: !isReplayView && !!results.replay,
  };
  openScreen("results");
  app.focusNext = "btn-results-next";
  announce(T("{headline}. Total score {score}.", { headline, score: results.score.total }), true);
  if (extra.newlyUnlocked?.length) audio.play("achievement");
}
/** The results screen's leaderboard line (Score chase, signed in). */
export function leaderboardLine(): string | null {
  const r = currentFlow?.lb;
  if (!r || app.results?.isReplay) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
/** Results buttons: next stage / next lesson / play again. */
export function resultsNext(): void {
  const flow = currentFlow;
  const v = app.results;
  if (!flow || !v) return;
  if (v.isReplay) { startRound(replaySource!.originalFlow); return; }
  if (v.nextAction === "next-stage") {
    const idx = Content.JOURNEY_STAGES.findIndex((s) => s.id === flow.descriptor.id);
    const next = Content.JOURNEY_STAGES[idx + 1];
    if (next) { stopSession(); startAttract(); app.navStack = []; app.screen = null; app.setup = null; showSetup(stageFlow(next)); }
    return;
  }
  if (v.nextAction === "next-lesson") {
    const idx = Content.TUTORIALS.findIndex((t) => t.id === flow.tutorial!.id);
    const next = Content.TUTORIALS[idx + 1];
    if (next) startLesson(next);
    return;
  }
  restartRound();
}
export function restartRound(): void {
  if (replaySource) { startRound(replaySource.originalFlow); return; }
  if (currentFlow) startRound({ ...currentFlow, replay: null });
}
export function watchReplay(): void {
  const flow = currentFlow;
  if (!flow?.lastResults?.replay) return;
  const results = flow.lastResults;
  const src: ReplaySource = { commands: results.replay.commands, cursor: 0, resultsCache: results, originalFlow: { ...flow } };
  startRound({ ...flow, mode: "replay", descriptor: flow.descriptor, replay: src });
}
export function quitRound(): void {
  stopSession();
  platform.save().snapshot = null;
  platform.persist();
  audio.setRound(null);
  goTitle();
}

// ------------------------------------------------------------------ mode entry points (main.js onAction)
export function stageFlow(st: Descriptor): Flow {
  return {
    mode: "journey", descriptor: st, title: () => T("Stage {n}: {name}", { n: st.index ?? 0, name: T(String(st.name)) }),
    subtitle: () => (st.teaches ? T("New concept: {concept}", { concept: T(TEACHES[st.teaches] || st.teaches) }) : ""),
  };
}
export function quickPlay(): void {
  const p = progression();
  const next = Content.JOURNEY_STAGES.find((st, i) => !p.stages[st.id]?.won && (i === 0 || p.stages[Content.JOURNEY_STAGES[i - 1]!.id]?.won));
  if (next) showSetup({ mode: "journey", descriptor: next, title: () => T("Stage {n}: {name}", { n: next.index ?? 0, name: T(String(next.name)) }) });
  else showSetup({ mode: "practice", descriptor: (o) => Content.practiceConfig(o.difficulty || "steady", o.theme), title: () => T("Practice") });
}
export function openMode(id: string): void {
  switch (id) {
    case "learn": navigate("learn"); break;
    case "journey": navigate("journey"); break;
    case "challenge": navigate("challenges"); break;
    case "daily": dailyPlay(); break;
    case "practice": showSetup({ mode: "practice", descriptor: (o) => Content.practiceConfig(o.difficulty || "steady", o.theme || "meadow"), title: () => T("Practice"), subtitle: () => T("Undo available. Unranked — experiment freely.") }); break;
    case "chase": showSetup({ mode: "chase", descriptor: chaseDescriptor(), title: () => T("Weekly Score Chase"), subtitle: () => T("Same garden all week for everyone. One long run.") }); break;
  }
}
export function dailyPlay(): void {
  const desc = dailyDescriptor();
  showSetup({
    mode: "daily", descriptor: desc, title: () => T("Daily Garden — {day}", { day: String(desc.day) }),
    subtitle: () => (platform.signedIn() ? T("One shared seed for everyone today. Personal best syncs to your account.") : T("One shared seed for everyone today. Ranked.")),
  });
}
export function selectStage(st: Descriptor): void { showSetup(stageFlow(st)); }
export function startLesson(t: Tutorial): void { startRound({ mode: "learn", descriptor: tutorialDescriptor(t), tutorial: t, title: () => T(t.name) }); }
export function selectChallenge(c: Descriptor): void {
  showSetup({ mode: "challenge", descriptor: { ...c, rulesetId: "challenge-v1" }, title: () => T(String(c.name)), subtitle: () => T(String(c.desc)) });
}
export function setSetupOption(key: string, value: string): void { if (app.setup) app.setup.options[key] = value; }
export function startSetup(): void { if (app.setup) startRound(app.setup.flow); }
export function equipCosmetic(id: string): void {
  const c = COSMETICS.find((x) => x.id === id);
  const p = progression();
  if (!c) return;
  if (!p.cosmetics.unlocked.includes(c.id)) {
    if (p.masteryPoints < c.cost) { toast(T("Needs {n} mastery points.", { n: c.cost }), "warn"); return; }
    p.cosmetics.unlocked.push(c.id);
  }
  p.cosmetics.equipped.trail = c.id;
  platform.persist();
}
export function replayTutorials(): void {
  progression().tutorials = {};
  platform.persist();
  navigate("learn");
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("inviteCopied")); } catch { toast(S("inviteLink", { url: link })); }
}
export function saveGuestName(name: string): void {
  if (platform.signedIn()) return;
  platform.save().name = String(name || "").trim().slice(0, 24);
  platform.persist();
  goBack();
}

// ------------------------------------------------------------------ the interrupted round (main.js resumeSnapshot)
export function snapshotLabel(): string | null {
  const snap = platform.save().snapshot as { mode?: string; state?: State; at?: number } | null;
  if (!snap) return null;
  try {
    const st = snap.state!;
    const d = new Date(Number(snap.at) || 0);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return T("{mode} · score {score} · length {len} · saved {time}", { mode: modeLabel(String(snap.mode)) || T("Round"), score: st.score.total, len: st.snake.body.length, time });
  } catch { return T("A previous round can be resumed."); }
}
export function discardSnapshot(): void { platform.save().snapshot = null; platform.persist(); }
export function resumeSnapshot(): void {
  const data = platform.save().snapshot as Record<string, unknown> | null;
  if (!data) { goTitle(); return; }
  try {
    stopAttract();
    const mode = String(data.mode);
    const tutorial = mode === "learn" ? Content.TUTORIALS.find((t) => t.id === data.contentId) ?? undefined : undefined;
    const descriptor = (data.descriptor as Descriptor | undefined) || Content.stageById(String(data.contentId)) || (tutorial ? tutorialDescriptor(tutorial) : null);
    if (!descriptor && !data.initialConfig) throw new Error("snapshot has no reproducible configuration");
    const config = (data.initialConfig as RulesConfig) || Content.toRulesConfig(descriptor!);
    const tickScale = Number(data.tickScale) || 1;
    stopSession();
    session = GameSession.fromSnapshot({ config, tickScale, mode, contentId: String(data.contentId), rulesetId: String(data.rulesetId), onEvent: onSessionEvent },
      JSON.stringify(data.state), data.replay);
    session.elapsedMs = Number.isFinite(data.elapsedMs) ? Number(data.elapsedMs) : session.state.tick * session.tickMs;
    currentFlow = { mode, descriptor: descriptor ?? ({ id: String(data.contentId), themeId: String(data.themeId) } as Descriptor), config, tutorial, ranked: mode !== "practice" && mode !== "learn" && tickScale === 1 };
    const lt = data.lessonTracker as { actions?: number; events?: number; done?: boolean } | null;
    lessonTracker = tutorial ? { tutorial, actions: lt?.actions || 0, events: lt?.events || 0, done: !!lt?.done } : null;
    replaySource = null;
    render.loadArena(config, Content.themeById(String(data.themeId || "meadow")));
    app.navStack = [];
    openScreen(null);
    audio.setRound({ intensity: mode === "practice" ? 0.3 : 0.55, ambience: Content.themeById(String(data.themeId || "meadow")).ambience });
    session.start(1.5);
    toast(T("Round restored from your last safe snapshot."));
  } catch (err) {
    console.warn(`snapshot restore failed: ${String(err)}`);
    discardSnapshot();
    toast(T("That snapshot could not be restored."), "warn");
    goTitle();
  }
}

// ------------------------------------------------------------------ the top bar's daily chip (main.js topbarVM)
export function dailyChipText(): string {
  const n = new Date(platform.nowMs());
  const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
  const mins = Math.max(0, Math.round((next - n.getTime()) / 60000));
  const played = progression().dailiesPlayed[dailyDescriptor().day as string];
  const vars = { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, "0") };
  return `${played ? "✓" : "◷"} ` + (platform.synced() ? T("Daily · next in {h}h{m}m", vars) : T("Daily · next in {h}h{m}m (local time)", vars));
}
export function dailyLabel(): string {
  const played = progression().dailiesPlayed[dailyDescriptor().day as string];
  return played ? T("Daily ✓ (best {score})", { score: played.score }) : T("Daily challenge");
}
export { pname };

// ------------------------------------------------------------------ input: actions (keys and pads)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "pause") {
    if (!fresh()) return;
    if (app.drawer) { app.drawer = null; return; }
    if (app.screen) { if (app.screen !== "title") goBack(); return; }
    if (app.pause) return; // the pause card's own close resumes
    if (session && !replaySource) togglePause();
    return;
  }
  if (app.screen || !session || app.pause) return;
  if (a === "up" || a === "down" || a === "left" || a === "right") { ui.setFocus(null); playerSteer(a); return; }
  if (a === "undo") doUndo();
  else if (a === "hint") doHint();
  // camera_reset: the camera springs re-centre on their own (as before)
});

// ------------------------------------------------------------------ input: the playfield (render.js pointer handlers)
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: render.Rect[] = [];
/** The playfield (window pixels): the old canvas between the rails, under the top bar. */
export const stage: render.Rect = { x: 0, y: 0, width: 0, height: 0 };
const inStage = (x: number, y: number): boolean => x >= stage.x && y >= stage.y && x <= stage.x + stage.width && y <= stage.y + stage.height;
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
let drag: { id: number; x0: number; y0: number; sx: number; sy: number; t0: number; swiped: boolean } | null = null;
let hover: { x: number; y: number } | null = null;
onTouch((e) => {
  lastTouch = clockMs;
  if ((e as unknown as { control?: boolean }).control) return;
  events.push({ kind: e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel", x: e.x, y: e.y, id: e.id });
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1 });
});
onPointerMove((x, y) => {
  if (clockMs - lastTouch < 600) return;
  hover = { x, y };
  if (drag && drag.id === -1) events.push({ kind: "move", x, y, id: -1 });
});
/** Tap a cell to steer toward it, swipe (26 px between steers) to steer, hover to preview (render.js). */
function pointerInput(): void {
  const sc = frame().scale;
  for (const ev of events.splice(0)) {
    if (ev.kind === "down") {
      drag = null;
      if (!playing() || !inStage(ev.x, ev.y) || onHud(ev.x, ev.y)) continue;
      drag = { id: ev.id, x0: ev.x, y0: ev.y, sx: ev.x, sy: ev.y, t0: clockMs, swiped: false };
      continue;
    }
    if (!drag || drag.id !== ev.id) continue;
    if (ev.kind === "move") {
      const dx = ev.x - drag.sx, dy = ev.y - drag.sy;
      if (Math.hypot(dx, dy) >= 26 * sc) {
        playerSteer(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
        drag.sx = ev.x; drag.sy = ev.y; drag.swiped = true;
      }
      continue;
    }
    const d = drag;
    drag = null;
    if (ev.kind === "cancel") continue;
    if (!d.swiped && Math.hypot(ev.x - d.x0, ev.y - d.y0) <= 12 * sc && clockMs - d.t0 <= 400) {
      const cell = render.pickCell(ev.x, ev.y);
      if (cell && session) {
        ui.setFocus(null);
        const head = session.state.snake.body[0]!;
        const dx = cell.x - head.x, dy = cell.y - head.y;
        if (dx || dy) playerSteer(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
      }
    }
  }
  // Mouse hover previews the cell (pointer type mouse only: never after touch).
  const show = hover && playing() && inStage(hover.x, hover.y) && !onHud(hover.x, hover.y) && clockMs - lastTouch >= 600;
  render.previewCell(show ? render.pickCell(hover!.x, hover!.y) : null);
}

// ------------------------------------------------------------------ the clock
let hidden = false;
const STEP = 1000 / 60;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += STEP;
  for (let i = 0; i < timers.length;) {
    if (timers[i]!.at <= clockMs) { const t = timers.splice(i, 1)[0]!; t.fn(); } else i++;
  }
  if (attract && !session) { driveAttract(); attract?.session.advance(STEP); }
  if (session) {
    if (replaySource) driveReplay();
    session.advance(STEP);
  }
  if (app.hintUntil && clockMs >= app.hintUntil) { app.hintUntil = 0; render.showHint(null); }
  if (app.toast && app.toast.until < clockMs) app.toast = null;
  if (app.caption && app.caption.until < clockMs) app.caption = null;
});
/** main.js driveAttract: a food-seeking demo serpent behind the title. */
function driveAttract(): void {
  const s = attract!.session;
  if (s.state.status !== "active") {
    if (s.phase === "done") { stopAttract(); startAttract(); }
    return;
  }
  const state = s.state, head = state.snake.body[0]!, rng = attract!.rng;
  const safe = Rules.getSafeTurns(state).map((a) => a.dir);
  const food = nearestFood(state, head);
  if (food && Rng.nextFloat(rng) < 0.8) {
    const want: Dir = Math.abs(food.x - head.x) > Math.abs(food.y - head.y) ? (food.x > head.x ? "right" : "left") : (food.y > head.y ? "down" : "up");
    if (safe.includes(want)) s.dispatch(want);
    else if (safe.length && Rng.nextFloat(rng) < 0.2) s.dispatch(safe[Rng.nextInt(rng, safe.length)]!);
  } else if (safe.length && Rng.nextFloat(rng) < 0.1) s.dispatch(safe[Rng.nextInt(rng, safe.length)]!);
}
function driveReplay(): void {
  const src = replaySource!, s = session!;
  if (s.state.status !== "active") return;
  while (src.cursor < src.commands.length && src.commands[src.cursor]!.tick <= s.state.tick + 1) {
    s.dispatch(src.commands[src.cursor]!.dir);
    src.cursor += 1;
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void {
  render.setPalette(platform.options.colorPalette);
  render.setCameraView(platform.options.cameraView);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyOptions();
  goTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => applyOptions());
platform.onProgressMerged(() => { if (app.screen === "title") announce(T("Progress restored from your StarHermit cloud save.")); });
onSessionEnded(() => toast(S("signedOut"))); // keep playing locally
onSuspend(() => {
  hidden = true;
  if (session && inRound() && !session.paused) session.pause("background");
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => {
  hidden = false;
  if (pausedByBackground && session) {
    pausedByBackground = false;
    const s = session.state;
    showPause(() => T("While you were away the garden froze (solo rounds pause). Score {score}, length {len}, tick {tick} — nothing moved.", { score: s.score.total, len: s.snake.body.length, tick: s.tick }));
    announce(T("Welcome back. The round was paused while you were away."));
  } else if (!session?.paused) audio.setSuspended(false);
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(platform.options.colorPalette, ui.preferences().highContrast);
  audio.update();
});
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  hudRects.length = 0;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput();
  const f = frame();
  const s = session ?? attract?.session ?? null;
  render.update(frameDt, f.width, f.height, stage);
  if (s) render.syncSnapshot(s.getSnapshot(), s.getAlpha(), Math.min(0.05, frameDt));
  if (pendingAnnounce) {
    try { ui.announce(pendingAnnounce.text, { politeness: pendingAnnounce.assertive ? "assertive" : "polite" }); } catch { /* the runtime keeps the newest */ }
    pendingAnnounce = null;
  }
});
export { BUILD_VERSION };
