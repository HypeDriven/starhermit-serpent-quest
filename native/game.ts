// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (js/rules.js: grid, serpent, food, rivals,
// commands, the fixed tick, scoring, replay), the content (js/content.js:
// themes, the 42 Journey stages, lessons, challenges, the Daily, practice),
// the seeded streams (js/rng.js), the session (js/session.js: countdown,
// fixed ticks on the host's clock, undo, replay envelope, results) and the
// save (js/progress.js).
import * as rules from "../js/rules.js";
import * as content from "../js/content.js";
import * as rng from "../js/rng.js";
import * as sessionMod from "../js/session.js";
import * as progress from "../js/progress.js";

export type Dir = "up" | "down" | "left" | "right";
export interface Cell { x: number; y: number }
export interface Rival { id: string; tier: "small" | "big"; dir: Dir; body: Cell[]; alive: boolean; growPending: number }
export interface Food extends Cell { kind: "berry" | "golden" }
export interface Goal { kind: string; count: number; progress: number; done: boolean }
export interface Score { food: number; growth: number; rivals: number; survival: number; objective: number; total: number }
export interface State {
  version: number; seed: number; tick: number; rngState: number; grid: { w: number; h: number };
  snake: { dir: Dir; queuedDir: Dir | null; body: Cell[]; growPending: number; alive: boolean };
  food: Food[]; rivals: Rival[]; obstacles: Cell[]; goals: Goal[]; score: Score;
  stats: { invalidActions: number; commands: number; foodEaten: number; rivalsDefeated: number; maxLength: number };
  status: "active" | "won" | "lost"; terminalReason: string | null;
  config: { tickMs: number; parTicks: number; maxTicks: number; moveLimit: number; goldenChance: number; foodCount: number; mechanics: { allowUndo?: boolean } };
}
export interface RulesConfig {
  seed: number; grid: { w: number; h: number }; start: { x: number; y: number; dir: Dir; length: number };
  food: { count: number; goldenChance: number }; rivals: { tier: string; length: number }[]; obstacles: Cell[];
  goals: { kind: string; count: number }[]; tickMs: number; parTicks: number; maxTicks: number; moveLimit: number; mechanics: { allowUndo?: boolean };
}
export interface Descriptor {
  id: string; name?: string; seed: number; grid: { w: number; h: number }; themeId: string; tickMs: number;
  goals: { kind: string; count: number }[]; rivals?: { tier: string; length: number }[]; moveLimit?: number; maxTicks?: number; parTicks?: number;
  mechanics?: { allowUndo?: boolean }; rulesetId?: string; day?: string; kind?: string; index?: number; teaches?: string | null; desc?: string;
  [k: string]: unknown;
}
export interface Theme {
  id: string; name: string; sky: number; fog: number; sun: number; sunIntensity: number; ground: number; groundDark: number;
  grass: number[]; flowers: number[]; hedge: number; rock: number; water: number; snakeHead: number; snakeBody: number; snakeBelly: number;
  rivalSmall: number; rivalBig: number; food: number; foodGolden: number; ambience: string;
}
export interface Tutorial { id: string; name: string; text: string; require: { action?: string; event?: string; goal?: boolean; count?: number }; config: Record<string, unknown> }
export interface Challenge extends Descriptor { desc: string }
export interface GameEvent { type: string; value?: number; dir?: Dir; kind?: string; cell?: Cell; reason?: string; code?: string; results?: Results; id?: string; length?: number }
export interface Replay { commands: { tick: number; id?: string; type: string; dir: Dir }[]; result: unknown; [k: string]: unknown }
export interface Results {
  sessionId: string; contentId: string; rulesetId: string; mode: string; won: boolean; reason: string | null; score: Score; ticks: number;
  invalidActions: number; elapsedMs: number; stats: State["stats"]; goals: Goal[]; seed: number; replay: Replay; lessonPassed?: boolean;
}
export interface Session {
  mode: string; contentId: string; sessionId: string; state: State; initialConfig: RulesConfig; replay: Replay; elapsedMs: number;
  readonly tickMs: number; readonly phase: string; readonly paused: boolean; countdownRemaining: number;
  getSnapshot(): State; getAlpha(): number; getSafeTurns(): { dir: Dir }[];
  start(countdownSeconds?: number): void; destroy(): void; advance(dtMs: number): void;
  dispatch(dir: Dir): { ok: boolean; reason?: string }; canUndo(): boolean; undo(): boolean;
  pause(reason?: string): void; resume(): void; abandon(): void;
}
export interface SessionOpts { config: RulesConfig; mode?: string; contentId?: string; rulesetId?: string; tickScale?: number; onEvent?: (e: GameEvent) => void }

export interface BoardEntry { name: string; me: boolean; score: number; won: boolean; invalidActions: number; elapsedMs: number; sessionId: string; ruleset: string | null; seed: string | null; when: string | null }
export interface Progression {
  stages: Record<string, { won?: boolean; bestScore?: number; bestTicks?: number; attempts?: number }>;
  tutorials: Record<string, { done?: boolean }>; achievements: Record<string, { at: number }>; masteryPoints: number;
  cosmetics: { unlocked: string[]; equipped: { trail: string } }; dailiesPlayed: Record<string, { score: number; won: boolean }>;
  totalRounds: number; currentStreakDays: number; lastDailyDay: string | null;
}
export interface Boards { daily: Record<string, BoardEntry>; chase: BoardEntry[]; challenges: Record<string, BoardEntry>; ghosts?: Record<string, BoardEntry[]> }
export interface SaveDoc { v: number; progression: Progression; boards: Boards; snapshot: Record<string, unknown> | null; name: string }
export interface Options { colorPalette: string; leftHanded: boolean; haptics: boolean; captions: boolean; timingAssist: boolean; cameraView: string }

interface RulesApi {
  createGame(c: RulesConfig): State; getLegalActions(s: State): { dir: Dir }[]; getSafeTurns(s: State): { dir: Dir }[];
  applyCommand(s: State, c: { type: string; dir: Dir }): { state: State }; advanceTick(s: State): { state: State; events: GameEvent[] };
  deserializeState(j: unknown): State;
}
interface ContentApi {
  THEMES: Theme[]; JOURNEY_STAGES: Descriptor[]; TUTORIALS: Tutorial[]; CHALLENGES: Challenge[];
  PRACTICE_DIFFICULTIES: { id: string; name: string }[]; themeById(id: string): Theme; dailyConfig(d?: Date): Descriptor;
  practiceConfig(d: string, theme?: string): Descriptor; toRulesConfig(d: Descriptor): RulesConfig; stageById(id: string): Descriptor | null;
}
interface RngApi {
  createRng(seed: number): { state: number }; nextFloat(r: { state: number }): number; nextInt(r: { state: number }, n: number): number;
  seedFromString(s: string): number; hashString(s: string): string;
}
interface ProgressApi {
  defaultSave(): SaveDoc; normalize(raw: unknown): SaveDoc; mergeSave(remote: unknown, local: unknown): SaveDoc; sameSave(a: unknown, b: unknown): boolean;
  readForeign(text: string): SaveDoc | null; compareResults(a: BoardEntry, b: BoardEntry): number;
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[]; PALETTES: string[]; pickOptions(raw: unknown): Partial<Options>;
}

export const Rules = rules as unknown as RulesApi;
export const Content = content as unknown as ContentApi;
export const Rng = rng as unknown as RngApi;
export const Progress = progress as unknown as ProgressApi;
type SessionCtor = { new (o: SessionOpts): Session; fromSnapshot(o: SessionOpts, state: string, replay: unknown): Session };
export const GameSession = (sessionMod as unknown as { GameSession: SessionCtor }).GameSession;
export const BUILD_VERSION = (sessionMod as unknown as { BUILD_VERSION: string }).BUILD_VERSION;
