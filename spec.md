# Serpent Quest — Product and Game Specification

**Document status:** running specification of the shipped game (a StarHermit engine script game); §0 describes the implementation, the design sections below stay the contract.  
**Game index:** 57  
**Genre:** Growth action game  
**Players:** 1 player; optional asynchronous score comparison  
**Targets:** the StarHermit client (Windows, macOS, Linux) and browsers through the engine's web runtime — desktop and phones, landscape and portrait  
**Rendering direction:** a 3D garden on `starhermit:scene` (three.js r160's look, three-like names) with the interface on `starhermit:ui`

## 0. Implementation on the StarHermit engine

Serpent Quest is a StarHermit engine **script game** (`starhermit.txt`: `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.23.0`, `engine.minor=20`, capabilities `platform`, `storage`, `clipboard`; `server=score-script.js`). The StarHermit client plays it natively; browsers open `launch=index.html`, the engine's web loader that `npm run package` writes with `starhermit-files.json` (never edit them; repackage after every change).

- **Rules and content** are plain ES modules shared with the node tests and unchanged in what they decide: `js/rules.js` (grid, serpent, food, rivals, commands, the tick, scoring, replay), `js/content.js` (five themes, 42 Journey stages, five lessons, six challenges, the Daily, practice), `js/rng.js`, `js/session.js` (countdown, fixed ticks on the host's clock — `advance(dtMs)` — undo, replay envelope, results), `js/progress.js` (the save model: progression / boards merges, the old cloud slot, the game's options), `js/i18n.js` + `js/locales/` + `js/sh-strings.js`.
- **Client** (`native/*.ts`): `main.ts` (screen flow, modes, round lifecycle, results, achievements, local boards and garden spirits, input, the fixed-step clock, lifecycle), `screens.ts` (`starhermit:ui`), `render.ts` (`starhermit:scene`), `audio.ts`, `platform.ts`, `quality.ts`, `style.ts`, `i18n.ts`, `game.ts` (types for the JS modules). The procedural detail textures are baked once by `tools/bake-textures.mjs` (the old painters run in Chrome) into `assets/textures/` — per-pixel painting is far too slow in the native interpreter.
- **Time:** 60 Hz fixed steps drive the session (1000/60 ms a step against each round's tick length), the countdown, the attract serpent behind the title, replays and the short delays (results, hints, toasts, captions), so a hidden window or slow frames never move the round and play scripts replay exactly. A hidden window pauses a round (the pause card then says nothing moved).

### Controls

| Action | Keys (rebindable in the runtime's Options) | Gamepad |
|---|---|---|
| Steer up / down / left / right | ↑ W / ↓ S / ← A / → D | D-pad, left stick |
| Pause / back (`pause`) | Escape, P | Start |
| Undo — Practice (`undo`) | Z, Backspace | East (B) |
| Hint (`hint`) | H | South (A) |
| Reset camera (`camera_reset`) | C | Right stick press |

Pointer: a click on a tile steers toward it (the larger axis), hovering shows the preview ring. Touch: a tap on a tile steers toward it, a swipe steers every 26 px of travel, and the on-screen pad (▲ ◀ ▶ ▼) and Hint / Undo / Pause sit in the thumb tray (mirrored when Left-handed controls is on). The playfield is a named target describing the arena (length, heading, head cell, food, hunters) for screen readers, refreshed at most once a second. Menus: Tab / arrows / the D-pad move focus; Escape goes back.

### Screens

Title (over the attract garden: Play, Modes, Daily, Journey & achievements, Leaderboards, sign in / invite; an interrupted round left by closing the game offers Resume / Discard) → Modes (Learn, Journey, Daily, Practice, Challenge, Score chase) → Journey list / Learn list / Challenges → setup (round rules, tags, how to steer, Practice difficulty and garden theme) → countdown → the arena (top bar; Objective and Score / Status rails or their 🎯 / 📊 drawers; HUD; tray) ⇄ pause card (Resume, Restart round, Settings, Help, Leave round) → results (headline, reason, score breakdown, ticks · time · invalid moves · seed · build, achievements, comparison with the garden spirits or the stage best, the leaderboard line for a signed-in Score chase, Next stage / Next lesson / Play again, Retry, Watch replay, Leave). Also Help, Settings, Progression (achievements, cosmetics), Profile, Leaderboards (Weekly chase, Daily, and signed in the high-score board's Global / Friends lists).

### Settings

The runtime's Options own volumes and mute, graphics quality (Auto and levels, render scale, adaptive resolution, frame-rate limit), language, larger text, high contrast and reduced motion (the game follows `preferences().reducedMotion` and `ui.preferences().highContrast`); Settings links to them (**Open Options**, **Key bindings**). The game's own options are engine settings (device and account, same keys as the browser build): **Camera view** (angled / top-down), **Color palette** (standard, deuteranopia-, protanopia-, tritanopia-safe: the accent, danger and rival / food hues), **Left-handed controls**, **Haptics**, **Sound captions**, **Timing assistance** (25 % slower, rounds unranked). **Replay tutorials** clears the lesson marks.

### Graphics per quality tier

The browser build's presets keyed by `frame().quality` (`native/quality.ts`): Low — Lambert, no shadows, no post effects, MSAA, sparse foliage, plain surfaces; Balanced — Standard shading, 1024² shadows, bloom, grade, FXAA, reflections, medium foliage, detail textures; High — clear-coated Physical shading, 2048² shadows, GTAO, SMAA, dense foliage; Ultra — 4096² shadows, full GTAO, MSAA, 512 px textures, full-resolution bloom and GTAO. Counts (particles, pollen, grass share) scale with `frame().levelIndex` within a tier (≤ 1.5×). The look follows three r160: punctual light intensities ÷ π, `RoomEnvironment(renderer)` as each material's own environment at its old `envMapIntensity`, ACES, bloom 0.35 / 0.35 / 0.92, a linear-light grade (0.18 S-curve, saturation 1.1, split toning, 0.2 vignette).

### Layouts (logical px)

Wide (≥ 1024 wide): 260 px rails either side of the playfield under the top bar. Compact (< 1024): the rails become left / right drawers behind 🎯 / 📊 at the playfield's top corners. Portrait phones (≤ 700 wide): the Daily chip takes its own row of the top bar. Short landscape (≤ 500 tall): a slimmer bar, 48 px tray buttons, the pause card's buttons in two columns. Screens are ≤ 680 px wide, scroll when taller than the window, with their buttons pinned at the bottom. The camera keeps the playfield's aspect and is offset into it.

### Platform

Progress, boards, the paused round and the guest name are the engine save (`saves`, schema 1; device and cloud); a conflict merges both devices (`mergeSave`). The browser build's cloud slot (`game:<slug>`) is read once as a foreign save, merged in and replaced; its settings in the account's KV are adopted and removed. The Daily and the weekly chase follow the platform's clock (`serverNow()`, falling back to the device's UTC date). A finished ranked Score chase posts its total through `score-script.js` (a practice session carrying `{ type: 'result', scores: { 'high-score': n } }`, range-checked by the script), and the results show the rank. There is no multiplayer: the browser build never reached a hosted mode, and no client-reported result exists.

### Checks

`npm test`: the rules / content / server suite (`tests/run-tests.mjs`, incl. golden replays), `tests/progress.test.mjs`, `tests/i18n.test.mjs` (every string of `js/` and `native/` in all nine locales, no stray rows) and `tests/native.mjs` — the web index up to date, `tsc` against the generated host API, `starhermit check .` with zero warnings, and the play scripts in `tests/native/` from `tools/gen-plays.mjs` (a rules bot, `tools/plan.mjs`, plays each round on the exact fixed steps and the script expects its exact total): Journey 1–2 by keys with the replay and Next stage, the menus (Help, Settings, Profile name, Leaderboards, Challenges, pause / restart / tray pause), lessons 1–2 on a DPR-3 phone (pad taps and a swipe), Practice on a sideways phone with the Hint, and today's Daily (written at test time). `npm run test:browser` (`tools/browser-play.mjs`) plays the packaged game in Chrome on the GPU at desktop, phone (DPR 3) and landscape (DPR 3), failing on console errors or warnings.

### Known limitations

- Guests' browser-build localStorage progress (and an interrupted round saved there) cannot migrate; signed-in players' cloud progress migrates.
- The old per-effect graphics overrides, frame-rate readout and graphics summary are not offered: the runtime's Options choose a quality level. The screens' backdrop blur over the garden is left out (a plain 82 % veil).
- Music and the garden ambience are rendered once from a fixed seed and looped (the browser build rolled its plucks and chirps live); ambience plays on the music bus. The synthesized fallback blips played while a clip decoded are not ported.
- The hint arrows point toward the safe cells (the browser build drew the up and down arrows pointing back at the head).
- Kept from the rules (replays depend on them): rivals spawn at random free cells, so a hunter can catch the serpent within the first ticks of some gardens (e.g. Practice: Brisk on the meadow).
- Leaving a round from the pause card discards it, as before; the interrupted round on the title appears only when the game was closed while a round was paused.

## 1. Product vision

Serpent Quest is a game in which players steer a growing serpent through arenas, gather food, defeat smaller rivals, and avoid larger threats. Its signature setting is a colorful garden arena with softly waving grass. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Steer a growing serpent through arenas, gather food, defeat smaller rivals, and avoid larger threats.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **steer toward food and safe targets, grow, avoid threats, and complete arena objectives**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Score growth, survival, and objective completion. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The 3D scene fills the game region but is never the only UI. Menus, text, forms, settings and assistive descriptions are `starhermit:ui` widgets (each with an accessibility node) over or beside the scene; the arena description is a named target over the playfield.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation.
- **Large screens (above 1600×1000):** the shared `ui-scale.js` sets `--ui-scale` (`min(w/1600, h/1000)`, capped at 2.5); the topbar, rails, HUD, action tray, pause card, screens, sheets and fps meter are each CSS-zoomed by it, while the board canvas stays unzoomed and fills the remaining space. Nothing changes at 1600×1000 and below.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment, plus a "How to steer" card (input method, continuous motion, lethal walls) with a Learn shortcut for players with no lessons or attempts yet. Overlay screens start below the measured topbar so headings are never hidden behind it.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Daily challenge, local practice, pause, resume, results, and progression are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play.
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; UI widget equivalents for scene controls; headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

### Localization

- Every player-facing string — title and menus, mode cards, journey stages, lessons, challenges, practice difficulties and garden themes, setup facts, HUD, rails, pause card, captions, toasts, rule rejections, results, leaderboards (ghost spirit names included), progression, cosmetics, achievements, profile, help, board mirror and the StarHermit strings — ships in **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT**. Strings are authored in US English and looked up by that text (`js/i18n.js`, dictionaries in `js/locales/`, account strings in `js/sh-strings.js`); numbers and seeds stay locale-independent. Account and player-chosen names are never translated; the default guest name and the garden spirits are.
- The language is the runtime's (Options › Language; else the account's preferred language or the device's), mapped to the nearest shipped locale (`native/i18n.ts`). Every string is drawn through `T()` each frame, so a change shows on the next frame without touching the round.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a colorful garden arena with softly waving grass. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Three.js scene design

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.

### Graphics

See §0 (Graphics per quality tier): lighting with ACES and one warm key sun with shadows plus a sky-tinted hemisphere fill; each theme sets sky, fog, sun colour and strength; reflections from a filtered room environment; surface detail adds the baked mottled soil, hedge leaf and serpent scale maps with bump, clear-coated serpents and berries, and golden food whose emissive shimmer feeds bloom; ambient occlusion, bloom and the grade per tier; particle bursts with a soft sprite and drifting pollen at high particle quality (frozen with pause, hidden with reduced motion). Graphics never change rules, hazards or scoring.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

## 5. Technical architecture

### Client modules

See §0. No module mutates rules state except through a validated command; rendering consumes immutable snapshots plus the session's interpolation alpha; UI state and simulation state are separate.

### Determinism, replay, and security

- Fixed simulation step where physics exists; quantize authoritative inputs and define stable collision/order rules.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- Show useful progress by asset group; load core rules/UI first and scenic assets lazily. Provide procedural low-detail substitutes if optional assets fail.
- Cache immutable hashed assets and the last safe local snapshot. Updates activate between rounds, never during one.
- Device loss and graphics fallbacks are the runtime's; the game rebuilds its arena when the quality tier changes.
- Background tabs reduce rendering to zero or a low heartbeat while preserving required network lifecycle.

## 6. StarHermit integration

### Packaging and launch
- `starhermit.txt` declares the script game (see §0); `npm run package` writes the loader and file index; `.starhermitignore` leaves tests, tools, docs and the dev `server.js` out of the package.

### Identity, profile, presence, and preferences
- Signed in, the profile chip and title show the account's display name; guests keep an editable local name (saved with the progress). The game's options sync as engine settings; key bindings are the runtime's controls (`control.*` in `starhermit.txt`).

### Discovery, activity, and social layer
- Activity start/end and friends lists are host-owned chrome; the game calls neither on-platform. Surface entitlement or catalog state only in host-owned chrome; the game itself must remain playable without promotional interruption.
- Offer score comparison through a friends-filtered read of the platform leaderboard (`leaderboardEntries` with `scope=friends`) plus profile nicknames. When signed in, the title shows **Invite a friend**, which copies `StarHermit.inviteLink()` with a confirmation toast. Respect presence visibility and do not expose a hidden or private profile through game UI.
- Do not create gameplay chat or voice surfaces for the initial release; they are not relevant to the core solo loop. Friends-only leaderboard filtering and shareable challenge seeds supply the social layer without unnecessary communication permissions.

### Achievements and leaderboards
- Declare a small static achievement set: first completion, mechanic mastery, a sustained streak, a difficult content milestone, and an accessibility-neutral long-term goal. Keys are stable, lowercase identifiers; unlocks are idempotent.
- Signed in, Leaderboards reads the high-score board's global and friends entries (`starhermit:platform` `leaderboards`); personal bests stay in the save (device + cloud).
- Signed in, every finished ranked Score Chase run posts its total through a practice session (`sessions.practice()` + the game socket's `{ type: 'result', scores: { 'high-score': total } }`, as the JS SDK's `submitScores` did); `score-script.js` posts it to the `high-score` board (integer, higher is better, 0–1,000,000). The results screen shows "Posting score to the leaderboard…", then "Leaderboard rank: #N" (or "Score posted to the leaderboard." / "Score not posted to the leaderboard."), localized in `js/sh-strings.js`. Other modes post nothing; guests post nothing and see no line. Standalone daily results go only to the local board, which is labeled casual (not server-validated).
- Achievements stay local (part of the cloud-saved progression doc); a pure browser game has no server-authoritative unlock path, and the client never calls achievement-unlock endpoints.

### Sessions and transport
- The game is solo; rounds run locally and offline. There is no hosted or multiplayer mode (the browser build never had one), so no room-bound referee is needed; the only platform script is `score-script.js`.
- A daily session records content version, seed, settings affecting difficulty, an ordered input log, score components, and final checksum. Reconnect from the durable session snapshot rather than trusting cached client state.
- Realtime rooms, peer relay, matchmaking, backfill, and voice are intentionally not used because they add no value to this ruleset.

### Publishing and operations
- The platform script is `score-script.js` (declared with `server=score-script.js`; canonical copy in the games repo's `tools/score-script.js`): it range-checks a Score Chase total sent from a practice session and posts it to the `high-score` board. `server.js` is the browser build's local dev server with the localhost-only daily/replay validation (kept for its tests; not packaged). Choose a digest-pinned container only if profiling proves the sandbox unsuitable; no initial design here requires one.
- Define control defaults, achievement metadata, and versioned settings before release. Publish immutable build assets, verify the launch path, maintain migration tests for saves, and expose no secret configuration to the client.
- No per-game telemetry is sent (there is no platform endpoint for it).

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.
- `npm test` covers the graphics model (GPU detection, preset/override resolution, render-scale clamp, preset clearing overrides, locale completeness); `npm run test:e2e` drives Settings → Graphics at desktop and phone sizes (Low → High, a bloom override, reload persistence, Ultra, frame-rate readout) and fails on any console error or warning.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, dev-server score validation, friends-only leaderboard filtering, cloud-save conflict handling, launch-token refresh, and daily-boundary accuracy.
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.
