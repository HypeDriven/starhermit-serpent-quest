# Known Issues — Serpent Quest

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark185 (OBLITERATED Q8_0, 262k ctx),
alongside the game's own unit tests and a headless-Chrome boot check.

Fix pass 2026-09-05: all five originally-confirmed defects were re-verified against the current
source, fixed (see *Resolved defects* below), and confirmed by `npm test` (29/29) and the browser
e2e `tests/e2e.mjs` (desktop + mobile, `E2E PASS`, exit 0).

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
| `tests/e2e.mjs` (headless Chrome) | **present** — desktop + mobile playthroughs, `E2E PASS — serpent-quest, desktop + mobile, no page errors` (exit 0) |

## Resolved defects

All five original confirmed defects were re-verified against the current source, fixed (2026-09-05)
with the minimal change matching each documented "Expected" behaviour, and confirmed by the unit
suite and the browser e2e (both pass). Original defect numbers retained for traceability.

### 1. Daily scores could never be submitted — the client omitted the `day` field — RESOLVED

- **Fix:** `js/main.js:719-724` (`submitDailyScore`) now sets `day: flow.descriptor?.day`
  (from the daily descriptor, so `validateScoreClaim`'s `day-excluded` type test passes) and also
  carries `sessionId` for the tie-break. The payload that used to be rejected is now accepted.
- **Verified:** replaying the real client payload through `validateScoreClaim` now returns
  `{ ok: true, score:{...}, won:false, ticks:3, invalidActions:0, finalHash: ... }`.

### 2. Server leaderboard ignored the mandated tie-break order — RESOLVED

- **Fix:** `server.js` adds a `boardCompare` that implements the spec §2 order (won, higher score,
  fewer invalid actions, lower authoritative elapsed time, stable session identifier) and uses it
  for both `GET /boards/:id` sorting and the `POST /scores` best-entry rule. `validateScoreClaim`
  now also returns `invalidActions` (from the replayed state) and the entry stores
  `invalidActions` and `sessionId` so the remaining criteria can actually be applied at read time.
- **Verified:** equal-score entries are now separated deterministically; previously the board was
  raw-score-sorted with `Map` insertion order as the only fallback.

### 3. A second turn queued in the same tick silently discarded the first — RESOLVED

- **Fix:** `js/rules.js` — `applyCommand` and `getLegalActions` now validate a direction against
  `state.snake.dir` (the actual heading) instead of `state.snake.queuedDir || state.snake.dir`. A
  reverse-relative-to-heading press (e.g. going `right`, queuing `up`, then `left`) is now rejected
  immediately as an invalid action (with an `invalid` event and `invalidActions` increment) rather
  than overwriting and silently voiding the first, legal turn. The advertised legal set now matches
  exactly what `applyCommand` accepts (deterministic resolution, spec §2).
- **Verified:** the first valid turn is preserved and applied; the illegal second press is
  acknowledged, never silently dropped.

### 4. Undo did not rewind the replay log — RESOLVED

- **Fix:** `js/session.js` `undo()` now rewinds the replay envelope to match the restored state:
  `replay.commands` and `replay.hashes` are filtered to entries at or before the restored tick, and
  `elapsedMs` is reduced by `steps * tickMs`. The replayed round now reproduces the round actually
  played.
- **Verified:** the controller's recorded command list is truncated correctly and re-drives the
  restored state.

### 5. "Counted Steps" counted ticks, not player moves — RESOLVED

- **Fix:** `js/rules.js` `advanceTick`'s move-limit terminal check now reads
  `state.stats.commands` (the count of actual player moves) instead of `state.tick`. `tests/run-tests.mjs`
  was updated so the move-limit test drives one command per tick (`stepCirclingWithMoves`), since the
  limit is now correctly a count of player moves rather than elapsed simulation ticks.
- **Verified:** the "within 90 moves" challenge budget now reflects player input, not wall-clock
  tick time.

## Confirmed defects

(No outstanding confirmed defects; all five were resolved above.)

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

- **Hosted platform paths**: `js/platform.js` only issues requests when a `launch_token` is present
  in the URL, so presence heartbeats, activity start/end, telemetry, friends and cloud save were
  exercised only through the server handlers directly, never through the real host shell.
- **Rendering**: `js/render.js` (1490 lines) and `js/audio.js` were not reviewed for correctness
  beyond confirming the page raises no WebGL or console errors on boot.
- **Cloud-save conflict UI**: `mergeProgression` was read but the conflict branch was not exercised,
  as it requires two divergent cloud documents.
