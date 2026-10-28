// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.md) per game event — turn, eat, golden
// fruit, grow, rival defeated, death, win, invalid move, countdown tick, go,
// undo, UI click / back, pause and achievement — the generative pentatonic
// music (bass pad every 16 steps, triangle plucks over the melody, soft kick
// and hat ticks above intensity 0.4) and each garden's ambience bed (birds,
// crickets, night drone, wind, shore swells). The browser build synthesized
// the music and the beds live with WebAudio nodes and a session-seeded
// random stream; here each is rendered once from a fixed seed into a clip
// (a slice a frame) and looped while a round plays: the music at the
// round's intensity (Practice 0.3, every other mode 0.55), the bed of the
// round's garden. The beds play on the music bus at their old level (the
// runtime has no ambience bus). The runtime's Options own the volumes, mute
// and the voice limit; UI clicks play on the "interface" bus, the rest on
// "effects". The oscillator fallbacks the browser build played while a clip
// decoded are not ported (a live synthesis graph makes clip loads fail on the
// engine's web runtime), so a clip still loading is silent. Clips load once
// the mixer runs (natively at once, in a browser after the first press), one
// at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

const SAMPLE_FOR_EVENT: Record<string, string> = {
  turn: "turn-tick", eat: "eat-fruit", "eat-golden": "eat-golden-chime", grow: "grow-swell", "rival-defeated": "rival-defeated-hit",
  death: "death-thud", win: "win-fanfare", invalid: "invalid-buzz", countdown: "countdown-tick", go: "go-chime", undo: "undo-sweep",
  "ui-click": "ui-click", "ui-back": "ui-back", pause: "pause-swell", achievement: "achievement-chime",
};
/** audio.js CAPTIONS (English keys; translated where shown). */
export const CAPTIONS: Record<string, string> = {
  eat: "Cheerful blip — food eaten", "eat-golden": "Sparkling chime — golden fruit", grow: "Warm swell — serpent grows",
  "rival-defeated": "Impact — rival defeated", death: "Low thud — serpent down", win: "Victory arpeggio — quest complete",
  invalid: "Muted buzz — invalid move", countdown: "Metronome tick", go: "Confirm chime — go!", undo: "Reverse sweep — move undone",
  pause: "Soft swell — paused", achievement: "Badge chime — achievement unlocked",
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [...new Set(Object.values(SAMPLE_FOR_EVENT))];
let loading = false;
let suspended = false;

/** audio.js play(name): the event's clip, once loaded. */
export function play(name: string): void {
  if (suspended) return;
  const file = SAMPLE_FOR_EVENT[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: name === "ui-click" || name === "ui-back" ? "interface" : "effects" }); }
  catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); } // a clip the mixer lost: load it again
}

/** A hidden window or the pause card: the loops fade out (audio.js setDucked). */
export function setSuspended(on: boolean): void { suspended = on; }

// -- the rendered loops ----------------------------------------------------------------------------
const RATE = 22050;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NOTE = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** A voice to render: audio.js tone() (an enveloped oscillator) or noise() (filtered noise burst). */
interface Voice {
  t0: number; dur: number; vol: number; attack: number;
  osc?: "sine" | "triangle" | "square" | "sawtooth"; freq: number; endFreq?: number;
  filter?: "lowpass" | "highpass" | "bandpass";
}
/** audio.js envelope: exponential from 0.0001 to vol over attack, then exponential to 0.0001 at dur. */
function env(t: number, v: Voice): number {
  if (t < 0 || t > v.dur) return 0;
  if (t < v.attack) return 0.0001 * Math.pow(v.vol / 0.0001, t / v.attack);
  return v.vol * Math.pow(0.0001 / v.vol, (t - v.attack) / Math.max(1e-4, v.dur - v.attack));
}
/** A loop being rendered voice by voice, a slice a frame (the loop wraps: a long voice near the end rings into the start). */
class Loop {
  readonly buf: Float32Array;
  private i = 0;
  private done = false;
  private bedAt = 0;
  private k = 0;
  private ph = 0;
  private lp = 0;
  private lp2 = 0;
  private rnd: () => number = Math.random;
  constructor(seconds: number, private readonly voices: Voice[], private readonly bed: ((i: number) => number) | null, private readonly gain: number) {
    this.buf = new Float32Array(Math.round(seconds * RATE));
  }
  /** Renders up to `work` samples; true when finished. */
  step(work: number): boolean {
    if (this.done) return true;
    const n = this.buf.length;
    if (this.bed && this.bedAt < n) {
      const end = Math.min(n, this.bedAt + work);
      for (let k = this.bedAt; k < end; k++) this.buf[k]! += this.bed(k) * this.gain;
      this.bedAt = end;
      return false;
    }
    while (work > 0 && this.i < this.voices.length) {
      const v = this.voices[this.i]!;
      const len = Math.round(v.dur * RATE);
      if (this.k === 0) { this.rnd = mulberry32(this.i * 7919 + 17); this.ph = 0; this.lp = 0; this.lp2 = 0; }
      const start = Math.round(v.t0 * RATE);
      const end = Math.min(len, this.k + work);
      work -= end - this.k;
      for (let k = this.k; k < end; k++) {
        const t = k / RATE;
        const f = v.endFreq ? v.freq * Math.pow(v.endFreq / v.freq, t / v.dur) : v.freq;
        let s: number;
        if (v.osc) {
          this.ph = (this.ph + f / RATE) % 1;
          const ph = this.ph;
          s = v.osc === "sine" ? Math.sin(2 * Math.PI * ph) : v.osc === "triangle" ? (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph)
            : v.osc === "square" ? (ph < 0.5 ? 1 : -1) : 2 * ph - 1;
        } else {
          const w = this.rnd() * 2 - 1;
          const a = 1 - Math.exp((-2 * Math.PI * Math.min(f, RATE * 0.45)) / RATE);
          this.lp += (w - this.lp) * a;
          if (v.filter === "highpass") s = w - this.lp;
          else if (v.filter === "bandpass") { this.lp2 += (this.lp - this.lp2) * a; s = (this.lp - this.lp2) * 2; }
          else s = this.lp;
        }
        this.buf[(start + k) % n]! += s * env(t, v) * this.gain;
      }
      this.k = end;
      if (this.k >= len) { this.i++; this.k = 0; }
    }
    if (this.i >= this.voices.length) this.done = true;
    return this.done;
  }
}
/** A continuous low-passed noise bed whose level and cutoff follow `shape` (seamless: the filter warms up a second first). */
function noiseBed(seconds: number, seed: number, shape: (t: number) => { freq: number; vol: number }): (i: number) => number {
  const rnd = mulberry32(seed);
  const n = Math.round(seconds * RATE);
  let lp = 0;
  for (let k = 0; k < RATE; k++) { const sh = shape(((n - RATE + k) % n) / RATE); lp += (rnd() * 2 - 1 - lp) * (1 - Math.exp((-2 * Math.PI * sh.freq) / RATE)); }
  return (i) => {
    const sh = shape(i / RATE);
    lp += (rnd() * 2 - 1 - lp) * (1 - Math.exp((-2 * Math.PI * sh.freq) / RATE));
    return lp * sh.vol * 3; // a one-pole low-pass keeps about a third of the noise's level
  };
}

// audio.js startMusic: 64 steps of 0.22 s (spb at intensity ≤ 0.7); MELODY, BASS_LINE, SCALE as authored.
const MELODY = [69, 72, 74, 76, 79, 76, 74, 72, 69, 72, 74, 79, 81, 79, 76, 74];
const BASS_LINE = [45, 45, 41, 43];
function musicLoop(intensity: number): Loop {
  const spb = intensity > 0.7 ? 0.16 : 0.22;
  const r = mulberry32(0x5e9e47 + Math.round(intensity * 100));
  const bass = 0.16 + 0.06 * intensity, pluck = 0.14 + 0.08 * intensity;
  const perc = intensity > 0.4 ? 0.1 * Math.min(1, (intensity - 0.4) / 0.3) : 0;
  const voices: Voice[] = [];
  for (let step = 0; step < 64; step++) {
    const t = step * spb;
    if (step % 16 === 0) {
      const f = NOTE(BASS_LINE[(step / 16) | 0]!);
      voices.push({ t0: t, dur: spb * 16, vol: 0.5 * bass, attack: spb * 4, osc: "sine", freq: f });
      voices.push({ t0: t, dur: spb * 16, vol: 0.18 * bass, attack: spb * 4, osc: "triangle", freq: f * 1.005 });
    }
    if (step % 2 === 0) {
      const m = MELODY[(step / 2) % MELODY.length]!;
      if (r() < (intensity > 0.7 ? 0.9 : 0.55)) voices.push({ t0: t, dur: 0.3, vol: 0.4 * pluck, attack: 0.004, osc: "triangle", freq: NOTE(m) * (1 + (r() * 2 - 1) * 0.003) });
    }
    if (perc > 0 && step % 4 === 0) voices.push({ t0: t, dur: 0.08, vol: 0.5 * perc, attack: 0.003, filter: "lowpass", freq: 150, endFreq: 50 });
    if (perc > 0 && step % 2 === 1) voices.push({ t0: t, dur: 0.03, vol: 0.25 * perc, attack: 0.002, filter: "highpass", freq: 6000 });
  }
  return new Loop(64 * spb, voices, null, 0.5); // the music bus at 0.5
}

/** audio.js startAmbience(kind): the garden's bed, a fixed-seed loop (the old one rolled its chirps live). */
function ambienceLoop(kind: string): Loop {
  const r = mulberry32(0xa3b1e0 + kind.length * 31 + kind.charCodeAt(0));
  const v: Voice[] = [];
  const chirp = (t0: number, fMin: number, fMax: number, dur: number, vol: number): void => {
    const f = fMin + r() * (fMax - fMin);
    v.push({ t0, dur, vol, attack: 0.01, osc: "sine", freq: f, endFreq: f * (0.8 + r() * 0.5) });
  };
  let seconds = 14;
  let bed: (i: number) => number;
  if (kind === "birds") {
    seconds = 1.8 * 8;
    bed = noiseBed(seconds, 1, () => ({ freq: 600, vol: 0.02 }));
    for (let t = 1.8; t < seconds; t += 1.8) {
      if (r() < 0.6) { const n = 1 + Math.floor(r() * 3); let at = t; for (let i = 0; i < n; i++) { chirp(at, 2000, 4500, 0.08 + r() * 0.08, 0.025); at += 0.09 + r() * 0.08; } }
    }
  } else if (kind === "crickets") {
    seconds = 0.7 * 20;
    bed = noiseBed(seconds, 2, () => ({ freq: 500, vol: 0.012 }));
    for (let t = 0.7; t < seconds; t += 0.7) if (r() < 0.75) for (let i = 0; i < 3; i++) v.push({ t0: t + i * 0.07, dur: 0.04, vol: 0.02, attack: 0.005, osc: "sine", freq: 4200 + r() * 300 });
  } else if (kind === "night") {
    seconds = 2.5 * 6;
    const b = noiseBed(seconds, 3, () => ({ freq: 300, vol: 0.01 }));
    // the two sine drones (110 and 165 Hz, whole cycles in the loop)
    bed = (i) => b(i) + Math.sin((2 * Math.PI * 110 * i) / RATE) * 0.02 + Math.sin((2 * Math.PI * 165 * i) / RATE) * 0.014;
    for (let t = 2.5; t < seconds; t += 2.5) if (r() < 0.35) chirp(t, 3000, 5000, 0.1, 0.015);
  } else if (kind === "wind") {
    seconds = 2.2 * 6;
    // every 2.2 s a new cutoff (250–750 Hz) and level (0.02–0.045), approached smoothly
    const targets = Array.from({ length: 6 }, () => ({ freq: 250 + r() * 500, vol: 0.02 + r() * 0.025 }));
    bed = noiseBed(seconds, 4, (t) => {
      const k = Math.floor(t / 2.2) % 6, u = (t % 2.2) / 2.2, a = targets[(k + 5) % 6]!, b = targets[k]!;
      const e = 1 - Math.exp(-u * 1.6);
      return { freq: a.freq + (b.freq - a.freq) * e, vol: a.vol + (b.vol - a.vol) * e };
    });
  } else {
    // shore: a slow swell (0.015 → 0.055 over 3 s → 0.015 at 7 s), twice
    bed = noiseBed(seconds, 5, (t) => { const u = t % 7; return { freq: 500, vol: u < 3 ? 0.015 + (0.04 * u) / 3 : 0.055 - (0.04 * (u - 3)) / 4 }; });
  }
  return new Loop(seconds, v, bed, 0.5); // the ambience bus at 0.5
}

interface LoopSlot { loop: Loop; clip: AudioClip | null; voice: Sound | null }
const music = new Map<number, LoopSlot>();
const beds = new Map<string, LoopSlot>();
let want: { intensity: number; ambience: string } | null = null;

/** audio.js startMusic(intensity) + startAmbience(kind) for a round; null stops both (stopMusic / stopAmbience). */
export function setRound(next: { intensity: number; ambience: string } | null): void {
  if (want && next && want.intensity === next.intensity && want.ambience === next.ambience) return;
  want = next;
  for (const slot of [...music.values(), ...beds.values()]) {
    if (slot.voice) { try { slot.voice.stop(); } catch { /* gone */ } slot.voice = null; }
  }
}
function slotFor<K>(map: Map<K, LoopSlot>, key: K, make: () => Loop): LoopSlot {
  let s = map.get(key);
  if (!s) { s = { loop: make(), clip: null, voice: null }; map.set(key, s); }
  return s;
}

/** Each frame: the clips once the mixer runs (one at a time), the loops the round wants, then their levels. */
export function update(): void {
  if (context.state !== "running") return;
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading || !want) return;
  const slots = [slotFor(music, want.intensity, () => musicLoop(want!.intensity)), slotFor(beds, want.ambience, () => ambienceLoop(want!.ambience))];
  for (const s of slots) {
    if (s.clip) continue;
    if (!s.loop.step(4000)) return;
    try { s.clip = createClip([s.loop.buf], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  for (const s of slots) {
    if (!s.voice && !suspended && s.clip) {
      try { s.voice = playClip(s.clip, { bus: "music", loop: true, gain: 0 }); } catch { s.voice = null; }
      return; // loops start in separate frames
    }
  }
  for (const s of slots) {
    try { s.voice?.fade(suspended ? 0 : 1, 0.15); } catch { /* the mixer restarted */ }
  }
}
