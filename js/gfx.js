// Graphics quality model: presets, per-category overrides, StarHermit hardware-level
// detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js, no DOM) so the settings panel, the renderer
// and the Node tests agree on what each setting means. Graphics settings are
// presentation only: they never change rules, hazards or scoring.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  foliage: ['sparse', 'medium', 'dense'],
  particles: ['low', 'high'],
  detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a render scale (multiplies the capped device
// pixel ratio) and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', foliage: 'sparse', particles: 'low', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', foliage: 'medium', particles: 'high', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', foliage: 'dense', particles: 'high', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', foliage: 'dense', particles: 'high', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const FOLIAGE = {
  sparse: { grass: 800, flowers: 40 },
  medium: { grass: 2500, flowers: 90 },
  dense: { grass: 6000, flowers: 160 },
};
export const PARTICLE_SCALE = { low: 0.4, high: 1 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). The arena, serpents,
 * food, hazards, hit areas and rules are identical on every preset — only visuals change.
 *   material  serpent, food, hedge, rock and ground shading: lambert (Low) / standard (Balanced) /
 *             physical clear-coated scales and glossy food (High, Ultra; Detail on)
 *   texture   ground texture size in px (leaf and scale bump maps: half; Detail on)
 *   body      serpent body/belly/head sphere segments around (rings: about two thirds)
 *   grass     share of the Foliage tier's grass blades and flowers, scaled up with the level
 *   particles burst pool size (bursts scale with it), scaled with the level
 *   pollen    drifting pollen motes at Particles "high", scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texture: 128, body: 8, grass: 0.75, particles: 240, pollen: 50, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texture: 256, body: 12, grass: 0.85, particles: 400, pollen: 80, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texture: 256, body: 16, grass: 1, particles: 640, pollen: 110, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texture: 512, body: 24, grass: 1, particles: 800, pollen: 160, bloomRes: 1, aoRes: 1 },
};
export const PARTICLE_MAX = 1200;
export const POLLEN_MAX = 240;

/** A preset's concrete budget for a hardware level (counts scale ≤ 1.5× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(1.5, G.scaleBudget(1, lv, floor)) : 1;
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.pollen = Math.min(POLLEN_MAX, Math.round(b.pollen * k));
  b.grass = Math.min(1.5, Math.round(b.grass * k * 100) / 100);
  return b;
}

/** Old saved values (low/medium/high/auto) map onto the preset names. */
export function normalizePreset(v) {
  if (v === 'medium') return 'balanced';
  return PRESETS.includes(v) ? v : 'auto';
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const chosen = normalizePreset(s.preset);
  const preset = chosen !== 'auto' ? chosen : (PRESETS.includes(detected) ? detected : 'balanced');
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto: chosen === 'auto', renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset keeps scale/adaptive/fps but clears per-category overrides. */
export function choosePreset(saved, preset) {
  const out = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete out[cat];
  out.preset = preset === 'auto' ? 'auto' : normalizePreset(preset);
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
// `words` optionally localizes the summary (see gfx-strings.js `sum`).
const WORDS = {
  noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', grass: 'grass blades', noAa: 'no anti-aliasing',
};

/** Grass blades and flowers actually planted: the Foliage tier's counts × the preset budget's share. */
export function grassCount(r) { return Math.round(FOLIAGE[r.foliage].grass * (r.budget ? r.budget.grass : 1)); }
export function flowerCount(r) { return Math.round(FOLIAGE[r.foliage].flowers * (r.budget ? r.budget.grass : 1)); }

export function describe(r, pixels, words) {
  const w = { ...WORDS, ...(words || {}) };
  const parts = [
    r.shadows === 'off' ? w.noShadows : `${SHADOW_MAP[r.shadows]}² ${w.shadows}`,
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    `${grassCount(r)} ${w.grass}`,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
