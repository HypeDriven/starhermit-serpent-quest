// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS / FOLIAGE, each tuned to hold 60 FPS on the
// weakest GPU its Auto gave it) keyed by the runtime's quality tier
// (frame().quality), with the grass share, the burst pool and the pollen
// scaled within the tier by the level (frame().levelIndex, at most 1.5×), as
// the browser build scaled them by its hardware level. The runtime owns the
// rest of what the old Graphics panel did: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout. The old panel's per-effect overrides are not offered (the
// runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Serpent, food, hedge, rock and ground shading. */
  material: "lambert" | "standard" | "physical";
  /** Detail texture size in px (ground; leaf and scale bump maps half of it). */
  texture: 256 | 512;
  /** Serpent sphere segments around. */
  body: number;
  /** Share of the Foliage tier's grass blades and flowers. */
  grass: number;
  /** Burst pool size. */
  particles: number;
  /** Drifting pollen motes (Particles high). */
  pollen: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map size (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections (the room environment). */
  reflections: boolean;
  foliage: "sparse" | "medium" | "dense";
  particles: "low" | "high";
  /** Detail textures, clear-coated scales and glossy food. */
  detailed: boolean;
  budget: Budget;
}

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, foliage: "sparse", particles: "low", detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, foliage: "medium", particles: "high", detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, foliage: "dense", particles: "high", detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, foliage: "dense", particles: "high", detailed: true },
};
/** gfx.js BUDGETS (Low's 128 px textures were never drawn: Low is plain). */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, body: 8, grass: 0.75, particles: 240, pollen: 50, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, body: 12, grass: 0.85, particles: 400, pollen: 80, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, body: 16, grass: 1, particles: 640, pollen: 110, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, body: 24, grass: 1, particles: 800, pollen: 160, bloomRes: 1, aoRes: 1 },
};
export const FOLIAGE = { sparse: { grass: 800, flowers: 40 }, medium: { grass: 2500, flowers: 90 }, dense: { grass: 6000, flowers: 160 } };
export const PARTICLE_SCALE = { low: 0.4, high: 1 };
export const PARTICLE_MAX = 1200, POLLEN_MAX = 240;
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // gfx.js budgetFor: levels are about 1.64× apart in GPU throughput; counts grow with the level above the
  // tier's first, at most 1.5×.
  const k = Math.min(1.5, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.pollen = Math.min(POLLEN_MAX, Math.round(b.pollen * k));
  b.grass = Math.min(1.5, Math.round(b.grass * k * 100) / 100);
  return { preset, ...TABLE[preset], budget: b };
}
export function grassCount(l: Look): number { return Math.round(FOLIAGE[l.foliage].grass * l.budget.grass); }
export function flowerCount(l: Look): number { return Math.round(FOLIAGE[l.foliage].flowers * l.budget.grass); }
