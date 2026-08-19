// Serpent Quest — procedural audio engine (Web Audio API, zero dependencies).
// Everything is synthesized: oscillators, gain envelopes, one shared noise buffer.
// All public methods fail silent when the context is locked/unavailable/disposed.

// Tiny seeded PRNG (mulberry32) — session-seeded, so one-shots vary a little
// but stay replay-consistent within a session.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Original pentatonic loop (A minor pentatonic-ish, original melody).
const MELODY = [69, 72, 74, 76, 79, 76, 74, 72, 69, 72, 74, 79, 81, 79, 76, 74];
const BASS_LINE = [45, 45, 41, 43]; // A2 A2 F2 G2
const SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79]; // A3.. pentatonic

const CAPTIONS = {
  'eat': 'Cheerful blip — food eaten',
  'eat-golden': 'Sparkling chime — golden fruit',
  'grow': 'Warm swell — serpent grows',
  'rival-defeated': 'Impact — rival defeated',
  'death': 'Low thud — serpent down',
  'win': 'Victory arpeggio — quest complete',
  'invalid': 'Muted buzz — invalid move',
  'countdown': 'Metronome tick',
  'go': 'Confirm chime — go!',
  'undo': 'Reverse sweep — move undone',
  'pause': 'Soft swell — paused',
  'achievement': 'Badge chime — achievement unlocked',
};

export function createAudio(opts) {
  const getSettings = (opts && opts.getSettings) || (() => ({}));
  const rand = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);

  let ctx = null;          // AudioContext once unlocked
  let master = null;       // master gain -> destination
  let buses = null;        // { music, sfx, ambience, voice } gain nodes -> master
  let noiseBuf = null;     // shared 2s white-noise buffer
  let ducked = false;
  let disposed = false;

  let ambience = null;     // { stop() } handle for current ambience
  let music = null;        // scheduler state

  const settings = () => {
    try { return getSettings() || {}; } catch (_) { return {}; }
  };

  // --- graph bootstrap -------------------------------------------------------

  function buildGraph() {
    master = ctx.createGain();
    master.connect(ctx.destination);
    buses = {};
    for (const name of ['music', 'sfx', 'ambience', 'voice']) {
      const g = ctx.createGain();
      g.connect(master);
      buses[name] = g;
    }
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    const r = mulberry32(1234); // deterministic noise buffer
    for (let i = 0; i < len; i++) data[i] = r() * 2 - 1;
    applySettings();
  }

  function updateMaster() {
    if (!master) return;
    const s = settings();
    const target = s.muted ? 0 : (ducked ? 0.001 : 1);
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
  }

  function applySettings() {
    if (!ctx) return;
    try {
      const s = settings();
      buses.music.gain.setTargetAtTime(0.5 * (s.music ?? 1), ctx.currentTime, 0.05);
      buses.sfx.gain.setTargetAtTime(0.9 * (s.sfx ?? 1), ctx.currentTime, 0.05);
      buses.ambience.gain.setTargetAtTime(0.5 * (s.ambience ?? 1), ctx.currentTime, 0.05);
      buses.voice.gain.setTargetAtTime(0.9 * (s.voice ?? 1), ctx.currentTime, 0.05);
      updateMaster();
    } catch (_) { /* fail silent */ }
  }

  // --- synth primitives ------------------------------------------------------

  // Simple enveloped oscillator blip.
  function tone(bus, { freq = 440, type = 'sine', t0 = 0, dur = 0.15, vol = 0.3,
                       attack = 0.005, endFreq = null }) {
    const t = ctx.currentTime + t0;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // Filtered noise burst (impacts, ticks, waves).
  function noise(bus, { t0 = 0, dur = 0.2, vol = 0.2, type = 'lowpass',
                        freq = 1000, q = 1, endFreq = null, attack = 0.005 }) {
    const t = ctx.currentTime + t0;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (endFreq) f.frequency.exponentialRampToValueAtTime(Math.max(10, endFreq), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // Slight per-play variation (±semitone fraction).
  const vary = (f, amt = 0.04) => f * (1 + (rand() * 2 - 1) * amt);

  // --- one-shot effects ------------------------------------------------------

  const SFX = {
    turn(o) { // instant soft tick
      noise(buses.sfx, { dur: 0.03, vol: 0.12, type: 'highpass', freq: 2500, attack: 0.002 });
    },
    eat() { // bright rising two-note blip
      const f = vary(660);
      tone(buses.sfx, { freq: f, type: 'triangle', dur: 0.09, vol: 0.25 });
      tone(buses.sfx, { freq: f * 1.5, type: 'triangle', t0: 0.07, dur: 0.12, vol: 0.25 });
    },
    'eat-golden'() { // sparkling chime arpeggio
      [76, 79, 83, 88].forEach((m, i) =>
        tone(buses.sfx, { freq: vary(NOTE(m)), type: 'sine', t0: i * 0.07, dur: 0.25, vol: 0.2 }));
    },
    grow() { // short warm swell
      tone(buses.sfx, { freq: vary(220), type: 'sine', dur: 0.4, vol: 0.22, attack: 0.15, endFreq: 330 });
      tone(buses.sfx, { freq: 110, type: 'triangle', dur: 0.35, vol: 0.12, attack: 0.12 });
    },
    'rival-defeated'() { // noise burst + sine thump + triumphant motif
      noise(buses.sfx, { dur: 0.18, vol: 0.3, freq: 800, endFreq: 150 });
      tone(buses.sfx, { freq: 120, type: 'sine', dur: 0.25, vol: 0.4, endFreq: 50 });
      [69, 74, 76].forEach((m, i) =>
        tone(buses.sfx, { freq: NOTE(m), type: 'triangle', t0: 0.18 + i * 0.09, dur: 0.18, vol: 0.2 }));
    },
    death() { // low thud + descending tone
      noise(buses.sfx, { dur: 0.25, vol: 0.35, freq: 300, endFreq: 60 });
      tone(buses.sfx, { freq: 90, type: 'sine', dur: 0.4, vol: 0.4, endFreq: 40 });
      tone(buses.sfx, { freq: 330, type: 'sawtooth', t0: 0.15, dur: 0.7, vol: 0.12, endFreq: 82, attack: 0.02 });
    },
    win() { // short original victory arpeggio
      [69, 72, 76, 81, 84].forEach((m, i) =>
        tone(buses.sfx, { freq: NOTE(m), type: 'triangle', t0: i * 0.11, dur: 0.3, vol: 0.22 }));
      tone(buses.sfx, { freq: NOTE(88), type: 'sine', t0: 0.55, dur: 0.6, vol: 0.2 });
    },
    invalid() { // dull muted buzz — error, not harsh
      tone(buses.sfx, { freq: vary(110, 0.02), type: 'square', dur: 0.14, vol: 0.08, attack: 0.01 });
      noise(buses.sfx, { dur: 0.1, vol: 0.06, freq: 250 });
    },
    countdown(o) { // soft metronome tick; value 3/2/1
      tone(buses.sfx, { freq: 880, type: 'sine', dur: 0.05, vol: 0.18, attack: 0.002 });
      noise(buses.sfx, { dur: 0.03, vol: 0.08, type: 'bandpass', freq: 3000, q: 2, attack: 0.002 });
    },
    go() { // higher confirm chime
      tone(buses.sfx, { freq: NOTE(81), type: 'triangle', dur: 0.25, vol: 0.25 });
      tone(buses.sfx, { freq: NOTE(88), type: 'sine', t0: 0.08, dur: 0.35, vol: 0.2 });
    },
    undo() { // quick reverse sweep
      noise(buses.sfx, { dur: 0.2, vol: 0.15, type: 'bandpass', freq: 400, endFreq: 3000, q: 3, attack: 0.08 });
      tone(buses.sfx, { freq: 500, type: 'sine', dur: 0.2, vol: 0.12, endFreq: 900, attack: 0.08 });
    },
    'ui-click'() {
      noise(buses.sfx, { dur: 0.025, vol: 0.1, type: 'bandpass', freq: 2000, q: 1.5, attack: 0.002 });
      tone(buses.sfx, { freq: vary(1200, 0.05), type: 'sine', dur: 0.04, vol: 0.08, attack: 0.002 });
    },
    'ui-back'() {
      noise(buses.sfx, { dur: 0.03, vol: 0.08, type: 'bandpass', freq: 1200, q: 1.5, attack: 0.002 });
      tone(buses.sfx, { freq: 700, type: 'sine', dur: 0.06, vol: 0.08, endFreq: 500, attack: 0.002 });
    },
    pause() { // soft mute-swell
      tone(buses.sfx, { freq: 330, type: 'sine', dur: 0.35, vol: 0.14, attack: 0.12, endFreq: 220 });
    },
    achievement() { // small badge chime
      tone(buses.sfx, { freq: NOTE(76), type: 'sine', dur: 0.15, vol: 0.2 });
      tone(buses.sfx, { freq: NOTE(83), type: 'sine', t0: 0.1, dur: 0.3, vol: 0.18 });
    },
  };

  function play(name, o) {
    if (!ctx || disposed) return;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const fn = SFX[name];
      if (fn) fn(o || {});
    } catch (_) { /* fail silent */ }
  }

  // --- ambience (quiet looping beds) ------------------------------------------

  function stopAmbience() {
    if (ambience) {
      try { ambience.stop(); } catch (_) {}
      ambience = null;
    }
  }

  function startAmbience(kind) {
    if (!ctx || disposed) return;
    try {
      stopAmbience();
      const timers = [];
      const nodes = [];
      const out = buses.ambience;

      // Helper: continuous filtered-noise source with its own gain.
      const noiseBed = ({ type = 'lowpass', freq = 400, q = 0.7, vol = 0.05 }) => {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf; src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = type; f.frequency.value = freq; f.Q.value = q;
        const g = ctx.createGain(); g.gain.value = vol;
        src.connect(f); f.connect(g); g.connect(out);
        src.start();
        nodes.push(src);
        return { f, g };
      };

      const chirp = (fMin, fMax, dur, vol) => {
        const f = fMin + rand() * (fMax - fMin);
        tone(out, { freq: f, type: 'sine', dur, vol, attack: 0.01, endFreq: f * (0.8 + rand() * 0.5) });
      };

      if (kind === 'birds') {
        noiseBed({ freq: 600, vol: 0.02 });
        timers.push(setInterval(() => {
          if (rand() < 0.6) {
            const n = 1 + Math.floor(rand() * 3);
            for (let i = 0; i < n; i++)
              setTimeout(() => { try { chirp(2000, 4500, 0.08 + rand() * 0.08, 0.025); } catch (_) {} }, i * (90 + rand() * 80));
          }
        }, 1800));
      } else if (kind === 'crickets') {
        noiseBed({ freq: 500, vol: 0.012 });
        timers.push(setInterval(() => {
          if (rand() < 0.75) {
            for (let i = 0; i < 3; i++)
              tone(out, { freq: 4200 + rand() * 300, type: 'sine', t0: i * 0.07, dur: 0.04, vol: 0.02, attack: 0.005 });
          }
        }, 700));
      } else if (kind === 'night') {
        [110, 165].forEach((f, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setTargetAtTime(0.02 - i * 0.006, ctx.currentTime + i * 0.5, 2);
          g.gain.value = 0;
          o.connect(g); g.connect(out); o.start();
          nodes.push(o);
        });
        noiseBed({ freq: 300, vol: 0.01 });
        timers.push(setInterval(() => {
          if (rand() < 0.35) chirp(3000, 5000, 0.1, 0.015);
        }, 2500));
      } else if (kind === 'wind') {
        const bed = noiseBed({ freq: 400, vol: 0.03 });
        timers.push(setInterval(() => {
          const t = ctx.currentTime;
          bed.f.frequency.setTargetAtTime(250 + rand() * 500, t, 1.5);
          bed.g.gain.setTargetAtTime(0.02 + rand() * 0.025, t, 1.2);
        }, 2200));
      } else if (kind === 'shore') {
        const bed = noiseBed({ freq: 500, vol: 0.02 });
        // slow wave-like swell cycle
        const cycle = () => {
          const t = ctx.currentTime;
          bed.g.gain.cancelScheduledValues(t);
          bed.g.gain.setValueAtTime(bed.g.gain.value, t);
          bed.g.gain.linearRampToValueAtTime(0.055, t + 3);
          bed.g.gain.linearRampToValueAtTime(0.015, t + 7);
        };
        cycle();
        timers.push(setInterval(cycle, 7000));
      } else {
        return; // unknown kind: just stay silent
      }

      ambience = {
        stop() {
          timers.forEach(clearInterval);
          nodes.forEach(n => { try { n.stop(); } catch (_) {} });
        },
      };
    } catch (_) { /* fail silent */ }
  }

  // --- generative music --------------------------------------------------------

  function stopMusic() {
    if (music) {
      try {
        clearInterval(music.timer);
        music.stemBass.g.disconnect();
        music.stemPluck.g.disconnect();
        music.stemPerc.g.disconnect();
      } catch (_) {}
      music = null;
    }
  }

  function startMusic(intensity) {
    if (!ctx || disposed) return;
    try {
      intensity = Math.max(0, Math.min(1, Number(intensity) || 0));
      if (music) { // idempotent: just retarget stem gains / pattern density
        music.intensity = intensity;
        applyStemGains();
        return;
      }
      const mkStem = () => {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(buses.music);
        return { g };
      };
      music = {
        intensity,
        step: 0,
        nextTime: ctx.currentTime + 0.1,
        stemBass: mkStem(), stemPluck: mkStem(), stemPerc: mkStem(),
        timer: null,
      };
      applyStemGains();
      // lookahead scheduler: tick every 40ms, schedule 0.15s ahead
      music.timer = setInterval(scheduleMusic, 40);
    } catch (_) { /* fail silent */ }
  }

  function applyStemGains() {
    const m = music;
    if (!m) return;
    const t = ctx.currentTime;
    const i = m.intensity;
    m.stemBass.g.gain.setTargetAtTime(0.16 + 0.06 * i, t, 0.3);
    m.stemPluck.g.gain.setTargetAtTime(0.14 + 0.08 * i, t, 0.3);
    // percussion only above 0.4, fades in
    m.stemPerc.g.gain.setTargetAtTime(i > 0.4 ? 0.1 * Math.min(1, (i - 0.4) / 0.3) : 0, t, 0.3);
  }

  function scheduleMusic() {
    const m = music;
    if (!m || disposed) return;
    try {
      const ahead = 0.15;
      const spb = m.intensity > 0.7 ? 0.16 : 0.22; // faster plucks at high intensity
      while (m.nextTime < ctx.currentTime + ahead) {
        scheduleStep(m, m.step, m.nextTime, spb);
        m.nextTime += spb;
        m.step = (m.step + 1) % 64;
      }
    } catch (_) { /* fail silent */ }
  }

  function scheduleStep(m, step, t, spb) {
    const rel = t - ctx.currentTime;

    // bass pad: long note every 16 steps
    if (step % 16 === 0) {
      const f = NOTE(BASS_LINE[(step / 16) | 0]);
      tone(m.stemBass.g, { freq: f, type: 'sine', t0: rel, dur: spb * 16, vol: 0.5, attack: spb * 4 });
      tone(m.stemBass.g, { freq: f * 1.005, type: 'triangle', t0: rel, dur: spb * 16, vol: 0.18, attack: spb * 4 });
    }

    // pluck melody: sparse generative picks over the pentatonic loop
    if (step % 2 === 0) {
      const melodyNote = MELODY[(step / 2) % MELODY.length];
      const density = m.intensity > 0.7 ? 0.9 : 0.55;
      if (rand() < density) {
        tone(m.stemPluck.g, {
          freq: NOTE(melodyNote) * (1 + (rand() * 2 - 1) * 0.003),
          type: 'triangle', t0: rel, dur: 0.3, vol: 0.4, attack: 0.004,
        });
      }
      // occasional fifth color tone at high intensity
      if (m.intensity > 0.7 && rand() < 0.2) {
        tone(m.stemPluck.g, {
          freq: NOTE(SCALE[Math.floor(rand() * SCALE.length)] + 12),
          type: 'sine', t0: rel + spb / 2, dur: 0.2, vol: 0.2, attack: 0.004,
        });
      }
    }

    // light percussion: soft hat ticks on off-beats, gentle kick on beat
    if (step % 4 === 0) {
      noise(m.stemPerc.g, { t0: rel, dur: 0.08, vol: 0.5, freq: 150, endFreq: 50, attack: 0.003 });
    }
    if (step % 2 === 1) {
      noise(m.stemPerc.g, { t0: rel, dur: 0.03, vol: 0.25, type: 'highpass', freq: 6000, attack: 0.002 });
    }
  }

  // --- lifecycle -----------------------------------------------------------------

  function unlock() {
    if (disposed) return;
    try {
      if (!ctx) {
        const AC = typeof window !== 'undefined' &&
          (window.AudioContext || window.webkitAudioContext);
        if (!AC) return; // Web Audio unavailable: stay silent
        ctx = new AC();
        buildGraph();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) {
      ctx = null; master = null; buses = null;
    }
  }

  function setDucked(d) {
    ducked = !!d;
    if (!ctx || disposed) return;
    try { updateMaster(); } catch (_) {}
  }

  function captionFor(name) {
    return Object.prototype.hasOwnProperty.call(CAPTIONS, name) ? CAPTIONS[name] : null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { stopAmbience(); } catch (_) {}
    try { stopMusic(); } catch (_) {}
    try { if (ctx) ctx.close().catch(() => {}); } catch (_) {}
    ctx = null; master = null; buses = null; noiseBuf = null;
  }

  return {
    unlock, applySettings, play,
    startAmbience, stopAmbience,
    startMusic, stopMusic,
    setDucked, captionFor, dispose,
  };
}
