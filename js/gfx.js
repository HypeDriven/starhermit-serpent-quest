// Graphics quality model: presets, per-category overrides, GPU detection and a
// cost summary. Pure (no three.js, no DOM) so the settings panel, the renderer
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

/** Best preset for this GPU, from the unmasked renderer string when exposed. */
export function detectPreset(gpu, opts = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
  // Phones and tablets: Auto never goes above Balanced (heat + battery).
  if (opts.mobile && (p === 'high' || p === 'ultra')) p = 'balanced';
  return p;
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
export function resolve(saved, detected) {
  const s = saved || {};
  const chosen = normalizePreset(s.preset);
  const preset = chosen !== 'auto' ? chosen : (PRESETS.includes(detected) ? detected : 'balanced');
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto: chosen === 'auto', renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
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

export function describe(r, pixels, words) {
  const w = { ...WORDS, ...(words || {}) };
  const parts = [
    r.shadows === 'off' ? w.noShadows : `${SHADOW_MAP[r.shadows]}² ${w.shadows}`,
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    `${FOLIAGE[r.foliage].grass} ${w.grass}`,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
