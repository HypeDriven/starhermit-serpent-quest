# Known Issues — Serpent Quest

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark185 (OBLITERATED Q8_0, 262k ctx),
alongside the game's own unit tests and a headless-Chrome boot check.

Method note: broad "find the defects in this module" prompts to the review model mostly came back
*NO DEFECTS FOUND*; the findings below were located by reading the source and then **re-executing
the real modules** to reproduce each one. Narrow, single-question prompts to the model were used
afterwards to double-check individual findings, and where that happened it is noted in the
evidence.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 29/29 pass |
| `node --check` on all modules | clean (9 `js/*.js` + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — substituted a CDP boot check (see *Not tested*): page loads, title "Serpent Quest", canvas present, **no console errors, no page exceptions, no failed requests** |

## Confirmed defects

Defects below were each verified by reading the source and re-executing it, not just reported by
the model.

### 1. Daily scores can never be submitted — the client omits the `day` field the server requires

- **File:** `js/main.js:719` (`submitDailyScore`) vs `server.js:50` (`validateScoreClaim`)
- **Trigger:** finish any ranked daily round while hosted.
- **Behaviour:** the payload built by `submitDailyScore` contains
  `contentVersion, rulesetId, seed, settings, inputLog, score, checksum, durationMs` — no `day`.
  `validateScoreClaim` starts with
  `if (typeof claim.day !== 'string' || excludedDays.has(claim.day)) return { ok:false, error:'day-excluded' }`,
  so `undefined` fails the type test and every submission is rejected with HTTP 422 `day-excluded`.
- **Expected:** a legitimate daily run reaches the daily board. `dailyConfig()` already returns
  `day` (`js/content.js:342`); it simply is not carried into the payload.
- **Evidence:** replaying the exact client payload through the real validator:

  ```
  client payload keys: contentVersion,rulesetId,seed,settings,inputLog,score,checksum,durationMs
  verdict as sent by client : {"ok":false,"error":"day-excluded"}
  verdict with day added    : {"ok":true,"score":{...,"total":50},"won":false,"ticks":3,...}
  ```

  The `day-excluded` code also mislabels the failure: nothing about that day was excluded.

### 2. Server leaderboard ignores the mandated tie-break order

- **File:** `server.js:102` (`GET /boards/:id`), and `server.js:93` (`POST /scores` best-entry rule)
- **Trigger:** two players post the same total on one daily board.
- **Behaviour:** the board is ordered by
  `[...board.values()].sort((a, b) => b.score - a.score)` — raw score only. Equal scores fall back
  to `Map` insertion order. The daily goal is `{kind:'score', count:500}`, and the score is a sum
  of discrete awards (10/50 per food, 5 per segment, 100 per rival, 250 per objective, `tick/10`
  survival), so equal totals between two *won* runs are ordinary — and nothing then separates them.
  `durationMs` is stored (`server.js:91`) but never consulted, and the entry records no
  `invalidActions` and no session identifier at all, so neither of the remaining criteria can even
  be applied at read time.
- **Expected:** spec §2 *Scoring and victory*: "Ties use, in order: primary objective completion,
  fewer invalid actions, lower authoritative elapsed time, then stable session identifier."
  The client already implements exactly this in `js/storage.js:149-155` (`compareResults`); the
  authoritative board does not.
- **Evidence:** `server.js:102` as quoted; `validateScoreClaim` returns `{score, won, ticks,
  finalHash}` and drops the invalid-action count it could have taken from the replayed state
  (`state.stats.invalidActions` is right there after `runReplay`). The client's own
  `compareResults` proves the intended ordering is known.

### 3. A second turn queued in the same tick silently discards the first, accepted turn

- **File:** `js/rules.js:267` (`applyCommand`) vs `js/rules.js:295` (`advanceTick`)
- **Trigger:** while travelling `right`, press Up and then Left before the next tick fires
  (~120–170 ms apart, easily done on keyboard or D-pad).
- **Behaviour:** `applyCommand` validates the new direction against
  `state.snake.queuedDir || state.snake.dir` — so `left` is checked against the queued `up` and is
  legal. `queuedDir` is overwritten to `left`. On the next tick, `advanceTick` re-validates with
  `turnError(state, snake.queuedDir, snake.dir)` — `left` against the *actual* direction `right` —
  which is a reverse, so the turn is dropped, `queuedDir` is cleared, and the serpent continues
  straight. The player's first (valid) turn is destroyed by the second, no `invalid` event is
  emitted and `stats.invalidActions` is not incremented, so nothing tells the player or the
  tie-break that an input was lost.
- **Expected:** spec §1 pillar 2 "One-input confidence: every press … gives immediate visual and
  sonic acknowledgment", and §2 "expose legal-action queries, deterministic resolution". An action
  that `getLegalActions()` advertises and `applyCommand()` accepts must not be silently voided.
- **Evidence:**

  ```
  dir right   legal up,down,right
  after queue up   : error=null queuedDir=up
  legal now        : up,left,right          <- 'left' advertised as legal
  after queue left : error=null events=[{"type":"turn","dir":"left"}] invalidActions=0
  head {"x":8,"y":8} -> {"x":9,"y":8}  dir now right  queuedDir null
  events this tick: []                     <- turn vanished, no invalid event
  ```

### 4. Undo does not rewind the replay log, so a replay of a practice round diverges

- **File:** `js/session.js:167-177` (`undo`)
- **Trigger:** in Practice (`mechanics.allowUndo: true`, `js/content.js:384`), press Undo (Z), then
  open **Watch replay** from the results screen.
- **Behaviour:** `undo()` pops up to two snapshots and restores the rules state, but leaves
  `this.replay.commands`, `this.replay.hashes` and `this.elapsedMs` untouched. The envelope
  therefore still contains the commands that were undone, at tick numbers that no longer match the
  state they were recorded against. `driveReplay` (`js/main.js:835-841`) re-dispatches that log
  against a fresh session, so the replayed round is not the round that was played.
- **Expected:** spec §5 *Determinism, replay, and security*: the replay envelope is
  "seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result"
  and must reproduce the run. `results.replay.result.finalHash` is also the checksum used for
  submission (`js/main.js:724`).
- **Evidence:** `js/session.js:167-177` contains no reference to `this.replay` or `this.elapsedMs`;
  the only mutations are `this.state`, `this._accumulator` and the `_undoStack`. Driving the real
  `GameSession` (six turns, then one Undo) shows the log left behind:

  ```
  practice allowUndo: true
  before undo: tick 12 | replay.commands 6 | replay.hashes 1
  undo() -> true | tick now 10 | replay.commands STILL 6 | replay.hashes STILL 1
  commands recorded at ticks already rewound past: [11]
  ```

  The command stamped `tick: 11` now sits in a log whose state is back at tick 10, so
  `driveReplay` re-issues it a tick early on the next viewing.

### 5. The "Counted Steps" challenge counts simulation ticks, not player moves — and is unwinnable

- **File:** `js/rules.js:387` (`advanceTick`), against `js/content.js:283-288` (`CHALLENGES[0]`)
- **Trigger:** start the challenge **Counted Steps** — "Finish 8 berries within 90 moves"
  (`moveLimit: 90`, `tickMs: 150`).
- **Behaviour:** the limit is enforced as
  `if (state.config.moveLimit > 0 && state.tick >= state.config.moveLimit)`, and `state.tick`
  advances on the fixed simulation timer whether or not the player does anything. `stats.commands`
  — the count of actual player moves — is never consulted. 90 ticks at 150 ms is 13.5 seconds of
  wall clock, so the "90 moves" allowance expires after a handful of inputs.
- **Expected:** the challenge text, the config key `moveLimit`, and the terminal reason
  `moves-exhausted` all promise a count of player moves. Spec §2 lists "move limits" as a
  Challenge-mode constraint distinct from "speed targets".
- **Evidence:** steering only when the cell ahead is unsafe, i.e. spending as few commands as
  possible:

  ```
  terminal: lost moves-exhausted | tick 90 | player commands issued: 6
            | real time at 150ms/tick: 13.5s | berries eaten: 1 of goal 8
  ```

  Six moves, not ninety — and the 8-berry goal is not reachable in the time allowed, so the
  challenge cannot be completed on its shipped seed.

## Suspected — not confirmed

### 1. `undo()` steps back two ticks, not one

- **File:** `js/session.js:171-173`
- **Concern:** `const steps = Math.min(2, this._undoStack.length)` pops two snapshots, but the top
  of `_undoStack` is already the state as it was one tick ago (pushed at the start of `_tick`), so
  a single Undo rewinds two ticks of play.
- **Why unconfirmed:** the inline comment ("one for the current in-flight state") suggests this is
  deliberate; without a design note it cannot be called wrong.

### 2. Dead duplicate-command guard in `dispatch`

- **File:** `js/session.js:146-148`
- **Concern:** the id is minted from a monotonically increasing module counter plus the session id
  immediately before the check, so `this._seenCommandIds.has(id)` can never be true. The
  idempotency the spec asks for is enforced only inside `runReplay`.
- **Why unconfirmed:** harmless in the local-only flow; whether the host ever replays commands into
  a live session is not established by the source.

## Checked, no defects found

- `js/rules.js` scoring: all components (`food`, `growth`, `rivals`, `survival`, `objective`) are
  integers; `finalizeScore` uses `Math.floor` for survival; `total` is their exact sum.
- `js/rules.js` terminal handling: every reason passes through the `TERMINAL_REASONS` allow-list in
  `terminate()`, which throws on an unknown reason.
- `js/rules.js` RNG discipline: `spawnFood`/`moveRival` rehydrate from `state.rngState` and persist
  it back on every draw, so replays are stream-stable. `runReplay` reproduces recorded hashes
  (exercised by the 29 unit tests, including the golden replay).
- Hints use the play API: `getSafeTurns()` filters `getLegalActions()` rather than duplicating
  legality, as spec §2 requires.
- `js/storage.js`: documents are checksummed (`wrap`/`unwrap`); a corrupted or truncated blob fails
  `hashString(parsed.body) !== parsed.checksum` and falls back to defaults instead of throwing;
  every `localStorage` access is inside try/catch, so a blocked-storage browser still boots.
- `js/content.js` daily generation: `dailyConfig` derives the seed from the UTC date string only
  (`date.toISOString().slice(0,10)`), so a day's seed is immutable, and `excludedDays` on the server
  is the exclusion mechanism spec §2 asks for.
- `server.js` `validateScoreClaim` re-simulates the input log against the server-side
  `dailyConfig`, rejects `seed-mismatch`, `stale-version` and `assisted-settings`, and stores the
  *replayed* score rather than the claimed one — so score inflation is not possible (defect 1
  notwithstanding).
- `POST /achievements` is idempotent via `Set` semantics and gated by `ACHIEVEMENT_KEYS`.

## Not tested

- **`tests/e2e.mjs`**: this game does not ship one. Substituted an equivalent boot check driving
  real headless Chrome over CDP against `python3 -m http.server` on port 39601 (the game's own
  `server.js` is API-only and returns 404 for `/`). It confirms a clean boot but does not play a
  round.
- **Hosted platform paths**: `js/platform.js` only issues requests when a `launch_token` is present
  in the URL, so presence heartbeats, activity start/end, telemetry, friends and cloud save were
  exercised only through the server handlers directly, never through the real host shell.
- **Rendering**: `js/render.js` (1490 lines) and `js/audio.js` were not reviewed for correctness
  beyond confirming the page raises no WebGL or console errors on boot.
- **Cloud-save conflict UI**: `mergeProgression` was read but the conflict branch was not exercised,
  as it requires two divergent cloud documents.
