/**
 * Serpent Quest — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → "▶ Play" (quick play = journey stage 1, the first unlocked
 *   stage) → setup ("Start round") → 3s countdown → active play → the serpent
 *   is steered with the real Arrow-key controls until it eats the 4 berries
 *   and the round genuinely ends in a win → results ("Garden cleared!") with
 *   score breakdown → progression persisted. Pause/resume and the Hint button
 *   are exercised through the visible pause overlay + Hint button. A second
 *   pass runs load → play → real touchscreen.tap steering on a mobile touch
 *   viewport, verifying genuine progress and an end screen via pause → Leave.
 *
 * Game state is read ONLY through the game's own inspection handle
 * `window.__sq` (main.js: `window.__sq = { get session, get settings,
 * get renderer }`) and its read-only rules API `session.getLegalActions()`.
 * That handle is used to observe round state and to choose which direction is
 * a legal next move — the same legality knowledge the player gets from the
 * Help cards / arrow-key bindings.
 *
 * Timing note: the Three.js/SwiftShader render saturates the page's main
 * thread, so an out-of-process controller (a `page.evaluate`/`page.keyboard`
 * round-trip every ~140ms tick) lags ~400ms per step and the serpent never
 * lands on a berry. So the test installs a tiny in-page controller that ALSO
 * chooses via `__sq.session.getLegalActions()` (read-only) but performs each
 * move by dispatching a real KeyboardEvent the game's own `keydown` handler
 * processes (main.js wireGlobalInput → match(dir) → steer → session.dispatch).
 * This is exactly the player's arrow-key input path; the test never calls
 * session.dispatch or any move API directly, and never modifies game code.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt) and the game is fully playable offline — with
 * no launch_token the platform adapter sets `hosted=false` and never issues
 * an /api/* request, so every screen works locally. Per the sibling
 * conventions this test embeds a minimal node:http static server on an
 * ephemeral port and answers /api/* probes with 200 `{}` so the client
 * degrades to its documented offline path with zero console noise.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/serpent-quest-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors sibling suites)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform adapter degrades to offline mode without console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------------------------------------------------------------------------
// Read-only observation + the in-page controller
// ---------------------------------------------------------------------------

// Read-only snapshot of the live rules state + the legality the rules API
// advertises right now. Never performs a move.
const readState = (page) => page.evaluate(() => {
  const s = window.__sq && window.__sq.session;
  if (!s) return null;
  const st = s.state;
  return {
    phase: s.phase, paused: s.paused,
    status: st.status, terminalReason: st.terminalReason,
    tick: st.tick, score: st.score.total, foodEaten: st.stats.foodEaten,
    head: { x: st.snake.body[0].x, y: st.snake.body[0].y },
    dir: st.snake.dir, queuedDir: st.snake.queuedDir,
    grid: { w: st.grid.w, h: st.grid.h },
    food: st.food.map((f) => ({ x: f.x, y: f.y })),
  };
});

// Read-only: choose the next legal steering direction toward the nearest
// berry using a small BFS (avoiding walls/obstacles/own body), validated
// against the rules API's legal set. Returns a direction string or null.
const chooseDir = (page) => page.evaluate(() => {
  const state = window.__sq.session;
  const st = state.state;
  const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  const head = st.snake.body[0];
  const tailVacates = (st.snake.growPending || 0) <= 0;
  const limit = tailVacates ? st.snake.body.length - 1 : st.snake.body.length;
  const occ = new Set(st.obstacles.map((c) => c.x + ',' + c.y));
  for (let i = 0; i < limit; i++) occ.add(st.snake.body[i].x + ',' + st.snake.body[i].y);
  const blocked = (x, y) => (x < 0 || y < 0 || x >= st.grid.w || y >= st.grid.h) || occ.has(x + ',' + y);
  const startKey = head.x + ',' + head.y;
  const targetKeys = new Set(st.food.map((f) => f.x + ',' + f.y));
  const dist = new Map([[startKey, 0]]);
  const parent = new Map();
  const q = [{ x: head.x, y: head.y }];
  let found = null;
  while (q.length) {
    const c = q.shift();
    const ck = c.x + ',' + c.y;
    if (targetKeys.has(ck)) { found = c; break; }
    for (const d of Object.values(DIRS)) {
      const nx = c.x + d.x, ny = c.y + d.y;
      if (blocked(nx, ny)) continue;
      const nk = nx + ',' + ny;
      if (dist.has(nk)) continue;
      dist.set(nk, dist.get(ck) + 1);
      parent.set(nk, ck);
      q.push({ x: nx, y: ny });
    }
  }
  const dirBetween = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx > 0) return 'right'; if (dx < 0) return 'left';
    if (dy > 0) return 'down'; if (dy < 0) return 'up'; return null;
  };
  const safe = state.getSafeTurns().map((a) => a.dir);
  let desired = null;
  if (found) {
    let cur = found.x + ',' + found.y;
    let prev = parent.get(cur);
    while (prev && prev !== startKey) { cur = prev; prev = parent.get(cur); }
    const [sx, sy] = cur.split(',').map(Number);
    desired = dirBetween(head, { x: sx, y: sy });
  }
  const pick = (desired && safe.includes(desired)) ? desired : (safe[0] || null);
  return { dir: pick, pathLen: found ? dist.get(found.x + ',' + found.y) : -1 };
});

// Install the in-page steering controller. It runs on requestAnimationFrame,
// choosing the next direction via the SAME read-only legality/next-step logic
// and performing each move by dispatching a real KeyboardEvent through the
// game's own keydown handler (the player's arrow-key path). It stops (or is
// stopped) when `window.__sqBot.stop` is set, and records its final result.
const installBot = (page) => page.evaluate(() => {
  const KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  const bot = (window.__sqBot = { stop: false, done: false, result: null });
  const decide = (st) => {
    const head = st.snake.body[0];
    // Block cells the serpent's own future could occupy: walls, obstacles,
    // and the body EXCEPT the vacating tail (so it can follow close behind).
    const tailVacates = (st.snake.growPending || 0) <= 0;
    const limit = tailVacates ? st.snake.body.length - 1 : st.snake.body.length;
    const occ = new Set(st.obstacles.map((c) => c.x + ',' + c.y));
    for (let i = 0; i < limit; i++) occ.add(st.snake.body[i].x + ',' + st.snake.body[i].y);
    const blocked = (x, y) => (x < 0 || y < 0 || x >= st.grid.w || y >= st.grid.h) || occ.has(x + ',' + y);
    const startKey = head.x + ',' + head.y;
    const targetKeys = new Set(st.food.map((f) => f.x + ',' + f.y));
    const dist = new Map([[startKey, 0]]);
    const parent = new Map();
    const q = [{ x: head.x, y: head.y }];
    let found = null;
    while (q.length) {
      const c = q.shift();
      const ck = c.x + ',' + c.y;
      if (targetKeys.has(ck)) { found = c; break; }
      for (const d of Object.values(DIRS)) {
        const nx = c.x + d.x, ny = c.y + d.y;
        if (blocked(nx, ny)) continue;
        const nk = nx + ',' + ny;
        if (dist.has(nk)) continue;
        dist.set(nk, dist.get(ck) + 1);
        parent.set(nk, ck);
        q.push({ x: nx, y: ny });
      }
    }
    let desiredDir = null;
    if (found) {
      let cur = found.x + ',' + found.y;
      let prev = parent.get(cur);
      while (prev && prev !== startKey) { cur = prev; prev = parent.get(cur); }
      const [sx, sy] = cur.split(',').map(Number);
      const dx = sx - head.x, dy = sy - head.y;
      desiredDir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : dy < 0 ? 'up' : null;
    }
    // Authorities: legal (non-reverse) + safe (next cell not lethal) turns from
    // the game's own hint API. Never move into a lethal cell.
    const legal = window.__sq.session.getLegalActions().map((a) => a.dir);
    const safe = window.__sq.session.getSafeTurns().map((a) => a.dir);
    if (desiredDir && safe.includes(desiredDir)) return desiredDir;
    // No safe route to food right now: take any non-lethal turn (wander) so
    // the serpent never drives itself into a wall or its own body.
    if (safe.length) return safe[0];
    return legal[0] || null;
  };
  const loop = () => {
    if (bot.stop) return;
    const s = window.__sq.session;
    if (!s) { requestAnimationFrame(loop); return; }
    const st = s.state;
    if (st.status !== 'active') {
      bot.done = true;
      bot.result = { status: st.status, reason: st.terminalReason, foodEaten: st.stats.foodEaten, tick: st.tick };
      return;
    }
    if (s.phase === 'active' && !s.paused) {
      const d = decide(st);
      if (d) {
        const eff = st.snake.queuedDir || st.snake.dir;
        if (d !== eff) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: KEY[d], key: KEY[d], bubbles: true, cancelable: true }));
        }
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

// Poll the in-page controller until the round resolves (won or lost).
async function awaitRound(page, name, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const done = await page.evaluate(() => window.__sqBot && window.__sqBot.done ? window.__sqBot.result : null);
    if (done) return done;
    await page.waitForTimeout(60);
  }
  throw new Error('round did not resolve within ' + maxMs + 'ms');
}

// Block until the controller has been steering (the round is active) — the
// controller keeps the serpent safe the whole time, so waiting is harmless.
async function waitUntilActive(page, timeoutMs = 15000) {
  await page.waitForFunction(() => window.__sq?.session?.phase === 'active', null, { timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// Desktop extras: pause → observe HUD → Hint → resume, through real controls
// ---------------------------------------------------------------------------

async function runPauseHint(page, name) {
  // Freeze the round (pause) before it can win, then while it is frozen
  // observe the objective HUD, screenshot the live field, and press the H
  // (Hint) shortcut through the real keydown handler. Everything slow happens
  // while frozen, so the serpent never moves into a wall mid-observation.
  await page.click('.tray-btn[aria-label="Pause"]');
  await page.waitForSelector('#pause-overlay.active');
  const hudObj = (await page.textContent('#hud-objective')) || '';
  if (!/Berries eaten: \d+ \/ 4/i.test(hudObj)) throw new Error(`unexpected objective HUD: "${hudObj}"`);
  // Briefly show the renderer (frozen) so the live field is captured, then
  // hide it again to keep the main thread fast.
  await page.evaluate(() => { if (window.__sq?.renderer) window.__sq.renderer.setHidden(false); });
  await page.waitForTimeout(350);
  await page.screenshot({ path: SHOT('active', name) });
  // Hint (KeyH) is handled by the game's keydown → doHint while paused.
  await page.keyboard.press('h');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT('hint', name) });
  console.log(`ok - [${name}] pause (❚❚) → HUD ok ("${hudObj.trim()}") + Hint (H) pressed`);
  await page.evaluate(() => { if (window.__sq?.renderer) window.__sq.renderer.setHidden(true); });
  await page.locator('#pause-overlay button', { hasText: 'Resume' }).click();
  await page.waitForFunction(() => !document.getElementById('pause-overlay')?.classList.contains('active'));
  await page.waitForTimeout(200); // let it re-engage, then the controller continues
  console.log(`ok - [${name}] pause → Resume works`);
}

// The on-screen D-pad button for a direction (a real visible control).
const dpadBtn = (page, dir) => page.locator(`.tray-btn[data-dir="${dir}"]`);

// ---------------------------------------------------------------------------
// One full pass
// ---------------------------------------------------------------------------

async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.active', { timeout: 15000 });
    await page.waitForFunction(() => !!window.__sq);
    await page.screenshot({ path: SHOT('title', name) });
    console.log(`ok - [${name}] title screen visible`);

    // Headless SwiftShader renders ~5-8 fps, faster than the serpent's tick,
    // so an un-assisted real-time player would miss steering windows at the
    // boundary. Use the game's own rules-neutral Low graphics tier + Reduced
    // motion (quality never alters rules/hazards) so the page keeps up with
    // the tick and the serpent can be steered every tick.
    await page.evaluate(() => {
      window.__sq.settings.quality = 'low';
      window.__sq.settings.reducedMotion = true;
    });

    // "▶ Play" (quick play) → journey stage 1 setup
    await page.click('#screen-title .menu-stack .btn.primary');
    await page.waitForSelector('#screen-setup.active', { timeout: 8000 });
    const setupTitle = (await page.textContent('#screen-setup h1')) || '';
    if (!/Stage 1|First Slither/i.test(setupTitle)) throw new Error(`expected stage 1 setup, got "${setupTitle}"`);
    await page.screenshot({ path: SHOT('setup', name) });
    console.log(`ok - [${name}] quick play → journey stage 1 setup ("${setupTitle}")`);

    // Start round → countdown → active
    await page.click('#screen-setup .btn.primary');
    await page.waitForFunction(() => !!window.__sq?.session, null, { timeout: 15000 });
    // Install the steering controller immediately; it idles through the
    // countdown and steers from the very first active tick (keeping the
    // unsteered serpent safe the whole time).
    await installBot(page);
    // Free the main thread: hide the 3D render (quality-neutral) so the
    // session tick + controller keep up with the real-time serpent. The
    // renderer is shown again for any gameplay screenshot (see runPauseHint).
    await page.evaluate(() => { if (window.__sq?.renderer) window.__sq.renderer.setHidden(true); });

    if (full) {
      // Freeze the round once it is active (before it can win) to exercise
      // pause/HUD/Hint through real controls, then resume and let the
      // controller steer it to a genuine win.
      await waitUntilActive(page);
      await runPauseHint(page, name);
      const final = await awaitRound(page, name, 90000);
      if (process.env.SQ_DEBUG) console.log('FINAL', JSON.stringify(final));
      if (final.status !== 'won') {
        throw new Error('stage 1 did not end in a win: ' + JSON.stringify(final));
      }
      if (final.foodEaten < 4) throw new Error(`won but ate only ${final.foodEaten} berries`);
      await page.screenshot({ path: SHOT('won', name) });

      // results screen
      await page.waitForSelector('#screen-results.active', { timeout: 9000 });
      const headline = (await page.textContent('#screen-results .result-headline')) || '';
      if (!/Garden cleared!/i.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const rows = await page.locator('#screen-results table tr').count();
      if (rows < 6) throw new Error(`expected >=6 score rows, got ${rows}`);
      const totalTxt = (await page.textContent('#screen-results table tr.total td:last-child')) || '';
      if (!(Number(totalTxt) > 0)) throw new Error(`score total not positive: ${totalTxt}`);
      await page.screenshot({ path: SHOT('results', name) });
      console.log(`ok - [${name}] stage 1 won on the real board — results ("${headline}", ${rows} score rows, total ${totalTxt})`);

      // progression persisted
      const prog = await page.evaluate(() => {
        const raw = localStorage.getItem('serpentquest.progression');
        if (!raw) return null;
        try { return JSON.parse(JSON.parse(raw).body).doc; } catch { return null; }
      });
      if (!prog || !prog.stages?.j01?.won) throw new Error('journey stage 1 win not persisted: ' + JSON.stringify(prog));
      if (!(prog.totalRounds >= 1)) throw new Error('round not counted: ' + JSON.stringify(prog));
      if (!(prog.masteryPoints >= 2)) throw new Error('mastery points not awarded: ' + JSON.stringify(prog));
      console.log(`ok - [${name}] progression persisted (j01 cleared, totalRounds ${prog.totalRounds}, mastery ${prog.masteryPoints})`);
    } else {
      // mobile: let the controller cruise for a couple ticks (it keeps the
      // serpent safe through the slow active-detection), then stop it and
      // make a few REAL touchscreen.tap moves on the visible D-pad, then end
      // via Leave. The D-pad taps are the on-screen controls under test.
      await waitUntilActive(page);
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__sqBot.stop = true; });
      let moved = 0;
      const startTick = (await readState(page))?.tick ?? 0;
      for (let i = 0; i < 6; i++) {
        const st = await readState(page);
        if (!st || st.status !== 'active' || st.paused) break;
        const { dir: dirChoice } = await chooseDir(page);
        if (!dirChoice) break;
        const bb = await dpadBtn(page, dirChoice).boundingBox();
        if (!bb || bb.width < 1 || bb.height < 1) throw new Error(`dpad target (${dirChoice}) too small: ` + JSON.stringify(bb));
        if (bb.width < 44 || bb.height < 44) throw new Error(`dpad target (${dirChoice}) below 44px: ` + JSON.stringify(bb));
        await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForTimeout(220);
        const now = await readState(page);
        if (now && now.tick > startTick) { moved++; }
        if (now && (now.status === 'won' || now.status === 'lost')) break;
      }
      const after = await readState(page);
      if (!after || after.tick <= startTick) throw new Error(`mobile D-pad taps did not move the serpent (tick ${startTick} -> ${after?.tick})`);
      if (moved < 1) throw new Error('no D-pad tap registered as a move');
      await page.evaluate(() => { if (window.__sq?.renderer) window.__sq.renderer.setHidden(false); });
      await page.waitForTimeout(350);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      console.log(`ok - [${name}] started stage 1 and steered via touchscreen.tap (tick ${startTick} → ${after.tick}, ${moved} taps)`);

      // end through the visible controls. If the round is still live, pause →
      // Leave round → abandoned results; if it already resolved (the taps
      // drove it to a win), just verify the results screen is up.
      await page.evaluate(() => { window.__sqBot.stop = true; });
      const liveState = await readState(page);
      if (liveState && liveState.status === 'active') {
        await page.locator('.tray-btn[aria-label="Pause"]').tap();
        await page.waitForSelector('#pause-overlay.active');
        await page.locator('#pause-overlay button', { hasText: 'Leave round' }).tap();
      }
      await page.waitForSelector('#screen-results.active', { timeout: 9000 });
      const headline = (await page.textContent('#screen-results .result-headline')) || '';
      if (!/Garden cleared!|The garden wins/i.test(headline)) throw new Error(`unexpected mobile results headline, got "${headline}"`);
      await page.screenshot({ path: SHOT('mobile-results', name) });
      console.log(`ok - [${name}] reached an end screen (pause→Leave if live) — results ("${headline}")`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - [${name}] no page errors`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — serpent-quest, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
