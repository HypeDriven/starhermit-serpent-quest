// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Quick play (journey stage 1) and steers the serpent toward the berries with real arrow-key
// events through the game's own keydown handler (the e2e controller's path, run from a timer so it is not
// charged to the frame), so the serpent slithers and grows, berries pop with particle bursts and the
// grass, pollen and camera follow animate; a finished round goes on to the next stage (no reloads).
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.active', { timeout: 20000 });
  await page.locator('#btn-settings-top').click();
  await page.waitForSelector('#screen-settings.active #gfx-card');
  await page.selectOption('#set-gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('game-canvas')?.dataset.gfxPreset === p, preset);
  await page.goto(page.url(), { waitUntil: 'load' }); // saved; back to the title screen
  await page.waitForSelector('#screen-title.active', { timeout: 20000 });
}

const installBot = (page) => page.evaluate(() => {
  const KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  const decide = (st) => {
    const head = st.snake.body[0];
    const limit = (st.snake.growPending || 0) <= 0 ? st.snake.body.length - 1 : st.snake.body.length;
    const occ = new Set(st.obstacles.map((c) => c.x + ',' + c.y));
    for (let i = 0; i < limit; i++) occ.add(st.snake.body[i].x + ',' + st.snake.body[i].y);
    const blocked = (x, y) => x < 0 || y < 0 || x >= st.grid.w || y >= st.grid.h || occ.has(x + ',' + y);
    const startKey = head.x + ',' + head.y;
    const targets = new Set(st.food.map((f) => f.x + ',' + f.y));
    const seen = new Set([startKey]);
    const parent = new Map();
    const q = [head];
    let found = null;
    while (q.length) {
      const c = q.shift();
      if (targets.has(c.x + ',' + c.y)) { found = c; break; }
      for (const d of Object.values(DIRS)) {
        const nx = c.x + d.x, ny = c.y + d.y, nk = nx + ',' + ny;
        if (blocked(nx, ny) || seen.has(nk)) continue;
        seen.add(nk); parent.set(nk, c.x + ',' + c.y); q.push({ x: nx, y: ny });
      }
    }
    let want = null;
    if (found) {
      let cur = found.x + ',' + found.y, prev = parent.get(cur);
      while (prev && prev !== startKey) { cur = prev; prev = parent.get(cur); }
      const [sx, sy] = cur.split(',').map(Number);
      want = sx > head.x ? 'right' : sx < head.x ? 'left' : sy > head.y ? 'down' : sy < head.y ? 'up' : null;
    }
    const safe = window.__sq.session.getSafeTurns().map((a) => a.dir);
    return want && safe.includes(want) ? want : safe[0] || null;
  };
  clearInterval(window.__sqBenchBot);
  window.__sqBenchBot = setInterval(() => {
    const s = window.__sq?.session;
    if (!s || s.phase !== 'active' || s.paused || s.state.status !== 'active') return;
    const d = decide(s.state);
    if (d && d !== (s.state.snake.queuedDir || s.state.snake.dir)) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: KEY[d], key: KEY[d], bubbles: true, cancelable: true }));
    }
  }, 25);
});

async function play(page) {
  await page.click('#screen-title .menu-stack .btn.primary');
  await page.waitForSelector('#screen-setup.active', { timeout: 8000 });
  await page.click('#screen-setup .btn.primary');
  await page.waitForFunction(() => !!window.__sq?.session, null, { timeout: 15000 });
  await installBot(page);
}

export async function start(page) {
  await play(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        // No reloads while measuring: the results screen's primary button (Next stage / Play again)
        // and the setup screen's Start keep the same page going.
        if (await page.locator('#screen-results.active').count()) await page.click('#screen-results .btn.primary', { timeout: 3000 });
        else if (await page.locator('#screen-setup.active').count()) await page.click('#screen-setup .btn.primary', { timeout: 3000 });
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(500).catch(() => {});
    }
  })();
  await page.waitForFunction(() => window.__sq?.session?.phase === 'active', null, { timeout: 15000 });
}
