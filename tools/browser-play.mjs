// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1
// is steered by keys, a tile is hovered and clicked, the hint shown (H) and
// the round paused (Escape) and left, then the Leaderboards and Settings
// open; on the phone lesson 1 is steered on the on-screen pad by finger (CDP
// touch events) to its results, then a Practice round is swiped and paused
// from the tray; sideways a round takes a Hint from the tray and pauses.
// Widgets are found through the page's accessibility mirror of the engine's
// UI. Screenshots of each step go to --shots. Fails on console errors or
// warnings, the runtime's error screen, or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const ONLY = process.env.VIEW;
const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views.filter((x) => !ONLY || x.name === ONLY)) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A drag from one named target to another: the mouse, or a finger (CDP touch). */
  const dragTo = async (from, to) => {
    const a = await find(from).boundingBox(), b = await find(to).boundingBox();
    const x1 = a.x + a.width / 2, y1 = a.y + a.height / 2, x2 = b.x + b.width / 2, y2 = b.y + b.height / 2;
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1 }] });
    else { await page.mouse.move(x1, y1); await page.mouse.down(); }
    for (let i = 1; i <= 12; i++) {
      const x = x1 + ((x2 - x1) * i) / 12, y = y1 + ((y2 - y1) * i) / 12;
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
      else await page.mouse.move(x, y);
      await page.waitForTimeout(40);
    }
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
    await page.waitForTimeout(300);
  };
  /** A finger's swipe across the middle of the page (CDP touch). */
  const swipe = async (dx, dy) => {
    const x1 = v.viewport.width / 2, y1 = v.viewport.height * 0.5;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1 }] });
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (dx * i) / 8, y: y1 + (dy * i) / 8, id: 1 }] }); await page.waitForTimeout(20); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  /** A quick finger tap (or click) at a box found earlier: lookups and DPR-3 screenshots take longer than a tick. */
  const tapBox = async (b) => {
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(150);
  };
  const go = async () => { await page.getByText('Go!', { exact: true }).first().waitFor({ timeout: 30000 }); await page.waitForTimeout(300); };
  let reached = false;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('▶ Play');
      await find('Start round').waitFor({ timeout: 15000 });
      await shot('setup');
      await press('Start round');
      await go();
      await page.keyboard.press('ArrowLeft');
      await page.mouse.move(v.viewport.width * 0.62, v.viewport.height * 0.45);
      await page.waitForTimeout(150);
      await page.keyboard.press('KeyH');
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(200);
      await shot('play'); // the round may have ended by now: a screenshot is slow
      if (await find('Leave').isVisible().catch(() => false)) await press('Leave');
      else { await page.keyboard.press('Escape'); await find('Resume').waitFor({ timeout: 15000 }); }
      if (await find('Leave round').isVisible().catch(() => false)) await press('Leave round');
      await press('Leaderboards');
      await find('Weekly chase').waitFor({ timeout: 30000 });
      await shot('boards');
      await press('← Back');
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await find('Accessibility').waitFor({ timeout: 15000 });
      await shot('settings');
    } else if (v.name === 'phone') {
      await press('Modes');
      await press('Learn');
      await press('Lesson 1: Steering');
      // the pad's boxes during the countdown, then quick finger taps (lookups and DPR-3 screenshots take longer than a tick)
      const boxes = [];
      for (const d of ['Steer left', 'Steer up', 'Steer right']) boxes.push(await find(d).boundingBox());
      await go();
      for (const b of boxes) {
        const x = b.x + b.width / 2, y = b.y + b.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        await page.waitForTimeout(60);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(250);
      }
      await page.getByText('Lesson complete!').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(600);
      await shot('lesson-results');
      await press('Leave');
      await press('Modes');
      await press('Practice');
      await press('Start round');
      const pauseBox = await find('Pause').boundingBox();
      await page.waitForTimeout(800);
      await tapBox(pauseBox);
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
      await go();
      await swipe(-120, 0);
      await page.waitForTimeout(300);
      await swipe(0, -120);
      await shot('swiped');
    } else {
      await press('▶ Play');
      await press('Start round');
      const hintBox = await find('Hint').boundingBox(), pauseBox = await find('Pause').boundingBox();
      // Paused from the tray during the countdown (the page's accessibility mirror shows "Go!" a little late:
      // a round on a 16-cell field can be lost before a check reacts to it).
      await page.waitForTimeout(800);
      await tapBox(pauseBox);
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
      await go();
      await tapBox(hintBox);
      await shot('hint');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
