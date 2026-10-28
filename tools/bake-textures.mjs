// Bakes the browser build's procedural detail textures (js/render.js
// detailTextures: tileable value-noise ground and hedge-leaf maps with their
// bump maps, the serpent's scale bump map and the soft particle dot) into
// assets/textures/*.png by running the old painters unchanged in Chrome on the
// GPU (~/games/tools/gpu-chrome.mjs). Per-pixel canvas painting is far too slow
// in the engine's native interpreter, so the engine client loads these PNGs.
// Sizes: 256 (Balanced, High) and 512 (Ultra) — the old texture budgets; Low
// drew no detail textures. Offline tool: node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'assets', 'textures');
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(join(root, 'package.json'))('playwright-core');
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');

// js/render.js (removed with the browser client; recoverable from git history), verbatim.
function painters() {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function tileNoise(size, seed, octaves) {
    const out = new Float32Array(size * size);
    const rnd = mulberry32(seed);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
      const cells = 4 << o;
      const grid = new Float32Array(cells * cells);
      for (let i = 0; i < grid.length; i++) grid[i] = rnd();
      for (let y = 0; y < size; y++) {
        const fy = (y / size) * cells, y0 = fy | 0, ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x++) {
          const fx = (x / size) * cells, x0 = fx | 0, tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
          const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
          const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
          const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
          out[y * size + x] += amp * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy);
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  }
  function canvasTexture(size, paint) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    paint(cv.getContext('2d'), size);
    return cv.toDataURL('image/png');
  }
  function greyTexture(size, fn) {
    return canvasTexture(size, (ctx, n) => {
      const img = ctx.createImageData(n, n);
      for (let i = 0; i < n * n; i++) {
        const v = Math.max(0, Math.min(255, Math.round(fn(i % n, (i / n) | 0) * 255)));
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }
  const all = {};
  for (const size of [256, 512]) {
    const G = size, L = size / 2;
    const n = tileNoise(G, 0x9a55, 5);
    const sp = mulberry32(0x5eed5);
    const speck = new Float32Array(G * G).map(() => sp());
    all[`ground-${size}`] = greyTexture(G, (x, y) => 0.8 + 0.2 * n[y * G + x] - (speck[y * G + x] > 0.985 ? 0.12 : 0));
    all[`ground-bump-${size}`] = greyTexture(G, (x, y) => n[y * G + x] * 0.7 + speck[y * G + x] * 0.3);
    const leaf = tileNoise(L, 0x1eaf, 4);
    all[`leaf-${size}`] = greyTexture(L, (x, y) => 0.72 + 0.28 * Math.pow(leaf[y * L + x], 0.8));
    all[`leaf-bump-${size}`] = greyTexture(L, (x, y) => leaf[y * L + x]);
    all[`scales-${size}`] = canvasTexture(L, (ctx, s) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, s, s);
      const rows = 8, cols = 8, w = s / cols, h = s / rows;
      for (let r = -1; r <= rows; r++) {
        for (let c = -1; c <= cols; c++) {
          const cx = (c + (r % 2 ? 0.5 : 0)) * w + w / 2, cy = r * h + h / 2;
          const g = ctx.createRadialGradient(cx, cy - h * 0.2, 1, cx, cy, w * 0.62);
          g.addColorStop(0, '#fff');
          g.addColorStop(0.75, '#999');
          g.addColorStop(1, '#000');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.ellipse(cx, cy, w * 0.58, h * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }
  all.dot = canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  return all;
}

const { browser, close } = await launchChrome(chromium);
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  const all = await page.evaluate(`(${painters.toString()})()`);
  for (const [name, url] of Object.entries(all)) {
    writeFileSync(join(out, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
    console.log(name);
  }
} finally { await close(); }
