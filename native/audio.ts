// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.md) per game event — turn, eat, golden
// fruit, grow, rival defeated, death, win, invalid move, countdown tick, go,
// undo, UI click / back, pause and achievement — the generative pentatonic
// music (bass pad every 16 steps, triangle plucks over the melody, soft kick
// and hat ticks above intensity 0.4) and each garden's ambience bed (birds,
// crickets, night drone, wind, shore swells). The browser build synthesized
// the music and the beds live with WebAudio nodes and a session-seeded
// random stream; here the engine's offline audio context renders each once
// from a fixed seed into a clip, looped while a round plays: the music at the
// round's intensity (Practice 0.3, every other mode 0.55), the bed of the
// round's garden. The beds play on the music bus at their old level (the
// runtime has no ambience bus). The runtime's Options own the volumes, mute
// and the voice limit; UI clicks play on the "interface" bus, the rest on
// "effects". The oscillator fallbacks the browser build played while a clip
// decoded are not ported, so a clip still loading is silent. Clips all load at
// start.
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type GainNode, type Sound } from "starhermit:audio";

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
let suspended = false;

/** Loads every clip at once (onStart). */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLE_FOR_EVENT))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
}

/** audio.js play(name): the event's clip, once loaded. */
export function play(name: string): void {
  if (suspended) return;
  const file = SAMPLE_FOR_EVENT[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: name === "ui-click" || name === "ui-back" ? "interface" : "effects" }); }
  catch { /* the mixer is full this frame: skip it */ }
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
type Off = OfflineAudioContext;
const Q_DB = 0; // Q 1, in dB as the engine's filters read it
/** One voice into `out`, with audio.js's envelope (exponential from 0.0001 to vol over attack, then to 0.0001 at dur). */
function scheduleVoice(off: Off, out: GainNode, v: Voice, index: number, lead: number): void {
  const t = lead + v.t0, end = t + v.dur;
  const g = off.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v.vol, t + v.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  g.connect(out);
  if (v.osc) {
    const osc = off.createOscillator();
    osc.type = v.osc;
    osc.frequency.setValueAtTime(v.freq, t);
    if (v.endFreq) osc.frequency.exponentialRampToValueAtTime(v.endFreq, end);
    osc.connect(g);
    osc.start(t);
    osc.stop(end);
  } else {
    const noise = off.createNoise({ seed: index * 7919 + 17, seconds: 1 });
    const f = off.createBiquadFilter();
    f.type = v.filter ?? "lowpass";
    f.frequency.setValueAtTime(Math.min(v.freq, RATE * 0.45), t);
    if (v.endFreq) f.frequency.exponentialRampToValueAtTime(v.endFreq, end);
    f.Q.value = Q_DB;
    noise.connect(f).connect(g);
    noise.start(t);
    noise.stop(end);
  }
}
/** A low-passed noise bed whose level and cutoff follow `shape` (automated every 0.1 s; seamless once settled). */
type Shape = (t: number) => { freq: number; vol: number };
function scheduleBed(off: Off, out: GainNode, seconds: number, seed: number, lead: number, shape: Shape): void {
  const noise = off.createNoise({ seed, seconds });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = Q_DB;
  const g = off.createGain();
  const at = (t: number): number => (t - lead + 2 * seconds) % seconds;
  lp.frequency.setValueAtTime(shape(at(0)).freq, 0);
  g.gain.setValueAtTime(shape(at(0)).vol * BED_LEVEL, 0);
  for (let t = 0.1; t < lead + seconds + 0.5; t += 0.1) {
    const sh = shape(at(t));
    lp.frequency.linearRampToValueAtTime(sh.freq, t);
    g.gain.linearRampToValueAtTime(sh.vol * BED_LEVEL, t);
  }
  noise.connect(lp).connect(g).connect(out);
  noise.start();
}
/** The bed's make-up gain, as the old one (a low-pass keeps about a third of the noise's level). */
const BED_LEVEL = 3;
/** The render past `lead`, `seconds` long, with what ran past the end wrapped to the start (a long voice rings into the start). */
async function renderLoop(seconds: number, gain: number, lead: number, build: (off: Off, out: GainNode) => void): Promise<AudioClip> {
  const length = Math.round(seconds * RATE), start = Math.round(lead * RATE);
  const off = new OfflineAudioContext(1, start + length + Math.round(4 * RATE), RATE);
  const out = off.createGain();
  out.gain.value = gain;
  out.connect(off.destination);
  build(off, out);
  const r = (await off.startRendering()).getChannelData(0);
  const data = r.slice(start, start + length);
  return createClip([data], RATE);
}
interface Loop { seconds: number; voices: Voice[]; beds: { seed: number; shape: Shape }[]; drones: [number, number][]; gain: number }
function renderOf(l: Loop): Promise<AudioClip> {
  const lead = 4; // the bed settles, and the tail of the loop's voices rings into its start from the copy before it
  return renderLoop(l.seconds, l.gain, lead, (off, out) => {
    for (const b of l.beds) scheduleBed(off, out, l.seconds, b.seed, lead, b.shape);
    for (const [hz, level] of l.drones) {
      const o = off.createOscillator(); o.frequency.value = hz;
      const g = off.createGain(); g.gain.value = level;
      o.connect(g).connect(out);
      o.start();
    }
    l.voices.forEach((v, i) => {
      scheduleVoice(off, out, v, i, lead);
      if (v.t0 + v.dur > l.seconds) scheduleVoice(off, out, { ...v, t0: v.t0 - l.seconds }, i, lead); // the wrap
    });
  });
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
  return { seconds: 64 * spb, voices, beds: [], drones: [], gain: 0.5 }; // the music bus at 0.5
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
  let bed: { seed: number; shape: Shape } | null = null;
  const drones: [number, number][] = [];
  if (kind === "birds") {
    seconds = 1.8 * 8;
    bed = { seed: 1, shape: () => ({ freq: 600, vol: 0.02 }) };
    for (let t = 1.8; t < seconds; t += 1.8) {
      if (r() < 0.6) { const n = 1 + Math.floor(r() * 3); let at = t; for (let i = 0; i < n; i++) { chirp(at, 2000, 4500, 0.08 + r() * 0.08, 0.025); at += 0.09 + r() * 0.08; } }
    }
  } else if (kind === "crickets") {
    seconds = 0.7 * 20;
    bed = { seed: 2, shape: () => ({ freq: 500, vol: 0.012 }) };
    for (let t = 0.7; t < seconds; t += 0.7) if (r() < 0.75) for (let i = 0; i < 3; i++) v.push({ t0: t + i * 0.07, dur: 0.04, vol: 0.02, attack: 0.005, osc: "sine", freq: 4200 + r() * 300 });
  } else if (kind === "night") {
    seconds = 2.5 * 6;
    bed = { seed: 3, shape: () => ({ freq: 300, vol: 0.01 }) };
    // the two sine drones (110 and 165 Hz, whole cycles in the loop)
    drones.push([110, 0.02], [165, 0.014]);
    for (let t = 2.5; t < seconds; t += 2.5) if (r() < 0.35) chirp(t, 3000, 5000, 0.1, 0.015);
  } else if (kind === "wind") {
    seconds = 2.2 * 6;
    // every 2.2 s a new cutoff (250–750 Hz) and level (0.02–0.045), approached smoothly
    const targets = Array.from({ length: 6 }, () => ({ freq: 250 + r() * 500, vol: 0.02 + r() * 0.025 }));
    bed = { seed: 4, shape: (t) => {
      const k = Math.floor(t / 2.2) % 6, u = (t % 2.2) / 2.2, a = targets[(k + 5) % 6]!, b = targets[k]!;
      const e = 1 - Math.exp(-u * 1.6);
      return { freq: a.freq + (b.freq - a.freq) * e, vol: a.vol + (b.vol - a.vol) * e };
    } };
  } else {
    // shore: a slow swell (0.015 → 0.055 over 3 s → 0.015 at 7 s), twice
    bed = { seed: 5, shape: (t) => { const u = t % 7; return { freq: 500, vol: u < 3 ? 0.015 + (0.04 * u) / 3 : 0.055 - (0.04 * (u - 3)) / 4 }; } };
  }
  return { seconds, voices: v, beds: bed ? [bed] : [], drones, gain: 0.5 }; // the ambience bus at 0.5
}

interface LoopSlot { clip: AudioClip | null; voice: Sound | null }
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
  if (!s) {
    const slot: LoopSlot = { clip: null, voice: null };
    renderOf(make()).then((c) => { slot.clip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
    s = slot;
    map.set(key, s);
  }
  return s;
}

/** Each frame once the mixer runs: the loops the round wants, then their levels. */
export function update(): void {
  if (context.state !== "running" || !want) return;
  const slots = [slotFor(music, want.intensity, () => musicLoop(want!.intensity)), slotFor(beds, want.ambience, () => ambienceLoop(want!.ambience))];
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
