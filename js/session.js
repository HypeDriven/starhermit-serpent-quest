// Session layer: owns the fixed-step loop around the pure rules engine.
// Only this module may advance rules state, and only through validated commands.
// Rendering consumes immutable snapshots + interpolation alpha; UI state and
// simulation state are strictly separate.

import {
  createGame, applyCommand, advanceTick, serializeState, deserializeState,
  hashState, getLegalActions, getSafeTurns, cloneState,
} from './rules.js';
import { hashString, canonicalJson } from './rng.js';
import { clearSnapshot } from './storage.js';

export const BUILD_VERSION = '1.0.0';

let commandCounter = 0;

export class GameSession {
  // opts: { config, mode, contentId, rulesetId, onEvent(event), tickScale }
  constructor(opts) {
    this.mode = opts.mode || 'practice';
    this.contentId = opts.contentId || 'unknown';
    this.rulesetId = opts.rulesetId || 'local-v1';
    this.sessionId = 's-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    this.onEvent = opts.onEvent || (() => {});
    this.tickScale = opts.tickScale || 1;

    this.state = createGame(opts.config);
    this.initialConfig = opts.config;
    this.initialHash = hashState(this.state);

    this.replay = {
      schema: 1,
      build: BUILD_VERSION,
      rulesetId: this.rulesetId,
      seed: this.state.seed,
      initialHash: this.initialHash,
      startedAt: Date.now(),
      commands: [],
      hashes: [{ tick: 0, hash: this.initialHash }],
      result: null,
    };

    this._seenCommandIds = new Set();
    this._undoStack = [];
    this._accumulator = 0;
    this._lastTime = 0;
    this._running = false;
    this._paused = false;
    this._rafId = 0;
    this.elapsedMs = 0;
    this.countdownRemaining = 0;
    this._phase = 'countdown'; // countdown -> active -> resolving -> done
    this._countdownEnd = 0;
  }

  get tickMs() {
    return Math.max(60, Math.round(this.state.config.tickMs * this.tickScale));
  }

  get phase() { return this._phase; }
  get paused() { return this._paused; }

  getSnapshot() { return this.state; } // treat as immutable
  getAlpha() {
    if (this._phase !== 'active' || this._paused) return 1;
    return Math.min(1, this._accumulator / this.tickMs);
  }

  getLegalActions() { return getLegalActions(this.state); }
  getSafeTurns() { return getSafeTurns(this.state); }

  start(countdownSeconds = 3) {
    this._phase = 'countdown';
    this._countdownEnd = performance.now() + countdownSeconds * 1000;
    this._lastTime = performance.now();
    this._running = true;
    const loop = (now) => {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(loop);
      this._frame(now);
    };
    this._rafId = requestAnimationFrame(loop);
    this.onEvent({ type: 'session-start', sessionId: this.sessionId });
  }

  destroy() {
    this._running = false;
    cancelAnimationFrame(this._rafId);
  }

  _frame(now) {
    const dt = Math.min(250, now - this._lastTime); // clamp tab-switch gaps
    this._lastTime = now;

    if (this._paused) {
      if (this._phase === 'countdown') this._countdownEnd += dt; // freeze the countdown clock
      return;
    }

    if (this._phase === 'countdown') {
      const remaining = (this._countdownEnd - now) / 1000;
      const prev = Math.ceil(this.countdownRemaining);
      this.countdownRemaining = Math.max(0, remaining);
      if (Math.ceil(this.countdownRemaining) !== prev) {
        this.onEvent({ type: 'countdown', value: Math.ceil(this.countdownRemaining) });
      }
      if (remaining <= 0) {
        this._phase = 'active';
        this.onEvent({ type: 'countdown', value: 0 });
        this.onEvent({ type: 'go' });
      }
      return;
    }
    if (this._phase !== 'active') return;

    this.elapsedMs += dt;
    this._accumulator += dt;
    // Fixed simulation step; never more than 8 catch-up ticks per frame.
    let steps = 0;
    while (this._accumulator >= this.tickMs && steps < 8 && this._phase === 'active') {
      this._accumulator -= this.tickMs;
      this._tick();
      steps++;
    }
    if (steps === 8) this._accumulator = 0; // drop excess rather than spiral
  }

  _tick() {
    if (this.state.config.mechanics.allowUndo) {
      this._undoStack.push(serializeState(this.state));
      if (this._undoStack.length > 300) this._undoStack.shift();
    }
    const { state, events } = advanceTick(this.state);
    this.state = state;
    for (const e of events) this.onEvent(e);
    if (this.state.tick % 50 === 0) {
      this.replay.hashes.push({ tick: this.state.tick, hash: hashState(this.state) });
    }
    if (this.state.status !== 'active') this._resolve();
  }

  // All player intent enters here. Commands carry unique ids; duplicates are
  // rejected idempotently instead of relying on debounce timers.
  dispatch(dir) {
    if (this._phase !== 'active' || this._paused) return { ok: false, reason: 'not-active' };
    const id = 'c' + (++commandCounter) + '-' + this.sessionId;
    if (this._seenCommandIds.has(id)) return { ok: false, reason: 'duplicate' };
    this._seenCommandIds.add(id);
    const cmd = { id, type: 'turn', dir };
    const res = applyCommand(this.state, cmd);
    if (!res.error) {
      this.replay.commands.push({ tick: this.state.tick + 1, id, type: 'turn', dir });
      this.state = res.state;
      this.onEvent({ type: 'input-ack', dir });
      for (const e of res.events) this.onEvent(e);
      return { ok: true };
    }
    for (const e of res.events) this.onEvent(e);
    this.state = res.state; // invalid-action counter lives in state
    return { ok: false, reason: res.error.reason, code: res.error.code };
  }

  canUndo() {
    return this.state.config.mechanics.allowUndo && this._undoStack.length > 0 && this._phase === 'active';
  }

  undo() {
    if (!this.canUndo()) return false;
    // Step back two ticks (one for the current in-flight state) when possible.
    const steps = Math.min(2, this._undoStack.length);
    let snap = null;
    for (let i = 0; i < steps; i++) snap = this._undoStack.pop();
    this.state = deserializeState(snap);
    this._accumulator = 0;
    // Rewind the replay envelope so the recorded run still matches the restored
    // state: drop commands/hashes stamped after the rewind point and subtract
    // the duration of the ticks we stepped back over.
    const stateTick = this.state.tick;
    this.replay.commands = this.replay.commands.filter((c) => c.tick <= stateTick);
    this.replay.hashes = this.replay.hashes.filter((h) => h.tick <= stateTick);
    this.elapsedMs = Math.max(0, this.elapsedMs - steps * this.tickMs);
    this.onEvent({ type: 'undo' });
    return true;
  }

  pause(reason = 'user') {
    if ((this._phase !== 'active' && this._phase !== 'countdown') || this._paused) return;
    this._paused = true;
    // Persistence is the host's job: it listens for this event and writes the
    // durable snapshot with whatever metadata the flow requires.
    this.onEvent({ type: 'pause', reason });
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._lastTime = performance.now();
    this.onEvent({ type: 'resume' });
  }

  abandon() {
    if (this.state.status === 'active') {
      this.state = cloneState(this.state);
      this.state.status = 'lost';
      this.state.terminalReason = 'abandoned';
      this._resolve();
    }
  }

  _resolve() {
    this._phase = 'resolving';
    const finalHash = hashState(this.state);
    this.replay.result = {
      status: this.state.status,
      reason: this.state.terminalReason,
      score: { ...this.state.score },
      ticks: this.state.tick,
      finalHash,
    };
    this.replay.hashes.push({ tick: this.state.tick, hash: finalHash });
    clearSnapshot();
    const results = this.getResults();
    this._phase = 'done';
    this.onEvent({ type: 'resolved', results });
  }

  getResults() {
    const s = this.state;
    return {
      sessionId: this.sessionId,
      contentId: this.contentId,
      rulesetId: this.rulesetId,
      mode: this.mode,
      won: s.status === 'won',
      reason: s.terminalReason,
      score: { ...s.score },
      ticks: s.tick,
      invalidActions: s.stats.invalidActions,
      elapsedMs: Math.round(this.elapsedMs),
      stats: { ...s.stats },
      goals: s.goals.map((g) => ({ ...g })),
      seed: s.seed,
      replay: this.replay,
    };
  }

  // Reconnect/resume from the durable snapshot, never from cached UI state.
  static fromSnapshot(opts, serializedState, replay) {
    const session = new GameSession(opts);
    session.state = deserializeState(serializedState);
    if (replay) session.replay = replay;
    session._phase = 'countdown';
    return session;
  }
}

export function replayEnvelopeSummary(replay) {
  return hashString(canonicalJson({
    schema: replay.schema, build: replay.build, rulesetId: replay.rulesetId,
    seed: replay.seed, initialHash: replay.initialHash, commands: replay.commands,
  }));
}
