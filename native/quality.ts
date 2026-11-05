// The look per graphics level. The engine owns its effects through
// levelSettings(): shadows and their map size, AO, bloom, grade and
// anti-aliasing come from the frame's level. The game keeps its art per quality
// tier (frame().quality): shading, foliage, textures and particles, with the
// bursts and pollen scaled within the tier by the level's particle budget (at
// most 1.5×). The runtime owns the rest of what the old Graphics panel did:
// Auto and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and the FPS readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map size (0 = off). */
  /** The level's shadow map size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
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
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget" | "shadows" | "ao" | "bloom" | "grade" | "antialias">> = {
  low: { reflections: false, foliage: "sparse", particles: "low", detailed: false },
  balanced: { reflections: true, foliage: "medium", particles: "high", detailed: true },
  high: { reflections: true, foliage: "dense", particles: "high", detailed: true },
  ultra: { reflections: true, foliage: "dense", particles: "high", detailed: true },
};
/** gfx.js BUDGETS (Low's 128 px textures were never drawn: Low is plain). */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, body: 8, grass: 0.75, particles: 240, pollen: 50 },
  balanced: { material: "standard", texture: 256, body: 12, grass: 0.85, particles: 400, pollen: 80 },
  high: { material: "physical", texture: 256, body: 16, grass: 1, particles: 640, pollen: 110 },
  ultra: { material: "physical", texture: 512, body: 24, grass: 1, particles: 800, pollen: 160 },
};
export const FOLIAGE = { sparse: { grass: 800, flowers: 40 }, medium: { grass: 2500, flowers: 90 }, dense: { grass: 6000, flowers: 160 } };
export const PARTICLE_SCALE = { low: 0.4, high: 1 };
export const PARTICLE_MAX = 1200, POLLEN_MAX = 240;
/** The level each tier's budgets were tuned at. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level's settings (plain data). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.pollen = Math.min(POLLEN_MAX, Math.round(b.pollen * k));
  return {
    preset, ...TABLE[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
export function grassCount(l: Look): number { return Math.round(FOLIAGE[l.foliage].grass * l.budget.grass); }
export function flowerCount(l: Look): number { return Math.round(FOLIAGE[l.foliage].flowers * l.budget.grass); }
