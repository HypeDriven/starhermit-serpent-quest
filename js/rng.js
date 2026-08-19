// Seeded, serializable random streams (mulberry32) + stable hashing.
// Rules, content-decoration, and audiovisual variants each use their own stream
// so cosmetic randomness can never leak into rules outcomes.

export function createRng(seed) {
  return { state: (seed >>> 0) || 0x9e3779b9 };
}

export function cloneRng(rng) {
  return { state: rng.state >>> 0 };
}

export function nextFloat(rng) {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Inclusive-exclusive integer in [0, n).
export function nextInt(rng, n) {
  return Math.floor(nextFloat(rng) * n);
}

export function pick(rng, arr) {
  return arr[nextInt(rng, arr.length)];
}

// FNV-1a 32-bit string hash, hex-encoded. Used for seeds and state hashes.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function seedFromString(str) {
  return parseInt(hashString(str), 16) >>> 0;
}

// Deterministic canonical JSON (sorted keys) so state hashes are stable
// across engines and key insertion order.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
