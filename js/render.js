// Serpent Quest — Three.js renderer module.
// Owns the WebGL renderer, scene graph, camera rig, VFX pools, quality tiers,
// pointer input, and the requestAnimationFrame loop. Consumes immutable rules
// snapshots (js/rules.js) and never mutates them. Top-level code is
// environment-free so the module imports cleanly in Node; only createRenderer
// touches the DOM/WebGL.

import * as THREE from '../vendor/three.module.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CELL = 1;
const LAYER_GAME = 0;    // gameplay + environment (raycastable)
const LAYER_DECOR = 1;   // grass, flowers, particles (never raycast)
const LAYER_MARKER = 2;  // selection rings, hint arrows (never raycast)

const CAMERA_FOV = 35;
const CAMERA_ELEVATION = 0.92;   // rad above horizon for the angled view
const CAMERA_FOLLOW = 0.12;      // weighted follow of the snake head
const CAMERA_FOLLOW_MAX = 1.4;   // world units
const SPRING_OMEGA = 5.2;        // critically damped spring rate

const MAX_JOINTS = 384;          // player serpent cap
const RIVAL_MAX_JOINTS = 64;
const SUB = 2;                   // curve samples per body joint
const MAX_FOOD_VIEWS = 16;
const MAX_PARTICLES = 640;       // pool size; tier scales spawn counts

const QUALITY_TIERS = {
  low:    { dpr: 1.0, shadows: false, grass: 800,  flowers: 40,  shadowMap: 512,  particleScale: 0.4 },
  medium: { dpr: 1.5, shadows: true,  grass: 2500, flowers: 90,  shadowMap: 1024, particleScale: 0.7 },
  high:   { dpr: 2.0, shadows: true,  grass: 6000, flowers: 160, shadowMap: 2048, particleScale: 1.0 },
};

const TAP_MAX_DIST = 12;         // px
const TAP_MAX_MS = 400;
const SWIPE_MIN_DIST = 26;       // px between swipe steers

// ---------------------------------------------------------------------------
// Deterministic local PRNG / hashing (decoration only — never rules state)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCell(x, y, seed) {
  let h = (seed >>> 0) ^ Math.imul(x + 0x9e3779b9, 374761393) ^ Math.imul(y + 0x85ebca6b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Color-vision palette adjustment: shift gameplay hues/luminance so food,
// golden food, and rivals stay distinguishable under common CVD types.
// Deterministic; presentation only.
// ---------------------------------------------------------------------------

function adjustForPalette(hex, role, palette) {
  if (!palette || palette === 'standard') return hex;
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  let { h, s, l } = hsl;
  if (palette === 'deuteranopia' || palette === 'protanopia') {
    // Red/green confusion: move warm reds toward blue-violet, then separate
    // roles by luminance (food bright, big rival dark).
    if (h < 0.16 || h > 0.9) h = (h + 0.5) % 1;
    if (role === 'food' || role === 'foodGolden') l = Math.min(0.72, l + 0.18);
    if (role === 'rivalSmall') l = Math.min(0.62, l + 0.1);
    if (role === 'rivalBig') l = Math.max(0.13, l * 0.45);
  } else if (palette === 'tritanopia') {
    // Blue/yellow confusion: pull yellows toward magenta, darken big rivals.
    if (h > 0.09 && h < 0.24) h = 0.93;
    if (role === 'foodGolden') l = Math.min(0.7, l + 0.12);
    if (role === 'rivalBig') l = Math.max(0.13, l * 0.5);
  }
  c.setHSL(h, Math.min(1, s), l);
  return c.getHex();
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

// Merge simple parts (geometry + matrix + flat color) into one non-indexed
// vertex-colored BufferGeometry. Used for authored props (food, hint arrows).
function mergeParts(parts) {
  const positions = [];
  const normals = [];
  const colors = [];
  const nMat = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const col = new THREE.Color();
  for (const part of parts) {
    const g = part.geom.index ? part.geom.toNonIndexed() : part.geom;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    nMat.getNormalMatrix(part.matrix);
    col.set(part.color);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(part.matrix);
      positions.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nor, i).applyMatrix3(nMat).normalize();
      normals.push(v.x, v.y, v.z);
      colors.push(col.r, col.g, col.b);
    }
    if (g !== part.geom) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return out;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// Critically damped spring (explicit velocity state; no cumulative lerp).
class Spring3 {
  constructor() {
    this.p = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.t = new THREE.Vector3();
  }
  snap(x, y, z) {
    this.p.set(x, y, z); this.t.set(x, y, z); this.v.set(0, 0, 0);
  }
  update(dt, omega) {
    const px = this.p.x, py = this.p.y, pz = this.p.z;
    const k = omega * omega, d = 2 * omega;
    this.v.x += (k * (this.t.x - px) - d * this.v.x) * dt;
    this.v.y += (k * (this.t.y - py) - d * this.v.y) * dt;
    this.v.z += (k * (this.t.z - pz) - d * this.v.z) * dt;
    this.p.set(px + this.v.x * dt, py + this.v.y * dt, pz + this.v.z * dt);
  }
}

// ---------------------------------------------------------------------------
// Pooled particle burst system (single THREE.Points, zero per-frame alloc)
// ---------------------------------------------------------------------------

class ParticlePool {
  constructor(scene) {
    this.max = MAX_PARTICLES;
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.baseCol = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.cursor = 0;
    this.active = 0;
    for (let i = 0; i < this.max; i++) this.pos[i * 3 + 1] = -1000;

    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('color', this.colAttr);
    this.material = new THREE.PointsMaterial({
      size: 0.14, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geom, this.material);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_DECOR);
    scene.add(this.points);
    this._rand = mulberry32(0x5eed);
  }

  // tier: 0 small (eat/move), 1 medium (grow/rival), 2 large (win/death)
  burst(x, y, z, hex, tier, countScale) {
    const counts = [12, 30, 90];
    let n = Math.round(counts[tier] * countScale);
    const c = new THREE.Color(hex);
    const speed = [1.6, 2.6, 4.2][tier];
    const up = [2.2, 3.2, 5.0][tier];
    const lifeBase = [0.45, 0.6, 0.9][tier];
    for (let i = 0; i < n; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const r = this._rand;
      const a = r() * Math.PI * 2;
      const m = (0.3 + r() * 0.7) * speed;
      this.pos[idx * 3] = x; this.pos[idx * 3 + 1] = y + 0.15; this.pos[idx * 3 + 2] = z;
      this.vel[idx * 3] = Math.cos(a) * m;
      this.vel[idx * 3 + 1] = up * (0.4 + r() * 0.8);
      this.vel[idx * 3 + 2] = Math.sin(a) * m;
      const shade = 0.7 + r() * 0.5;
      this.baseCol[idx * 3] = c.r * shade;
      this.baseCol[idx * 3 + 1] = c.g * shade;
      this.baseCol[idx * 3 + 2] = c.b * shade;
      this.maxLife[idx] = this.life[idx] = lifeBase * (0.6 + r() * 0.7);
    }
    this.active = this.max; // keep updating; cheap enough at this pool size
  }

  update(dt) {
    if (this.active <= 0) return;
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -1000;
        this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0;
        continue;
      }
      this.vel[i3 + 1] -= 7.5 * dt; // gravity
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.02) { this.pos[i3 + 1] = 0.02; this.vel[i3 + 1] *= -0.3; }
      const f = this.life[i] / this.maxLife[i];
      this.col[i3] = this.baseCol[i3] * f;
      this.col[i3 + 1] = this.baseCol[i3 + 1] * f;
      this.col[i3 + 2] = this.baseCol[i3 + 2] * f;
    }
    this.active = any ? 1 : 0;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Serpent view: smooth instanced chain along a Catmull-Rom curve through
// interpolated cell centers, plus an authored head (eyes, raised pose) and
// optional spiky back plates for big rivals. Keeps its own prev/cur buffers
// for tick interpolation.
// ---------------------------------------------------------------------------

class SerpentView {
  constructor(parent, opts) {
    this.scale = opts.scale;
    this.spiky = !!opts.spiky;
    this.maxJoints = opts.maxJoints;
    this.maxSamples = (this.maxJoints - 1) * SUB + 1;
    this.baseY = 0.3 * this.scale;
    this.prev = new Float32Array(this.maxJoints * 3);
    this.cur = new Float32Array(this.maxJoints * 3);
    this.work = new Float32Array(this.maxJoints * 3);
    this.prevLen = 0;
    this.curLen = 0;
    this.lastTick = -1;
    this.tilt = 0;          // turn-ack roll impulse
    this.wobble = 0;        // invalid-action shake
    this.pulse = 0;         // countdown/go scale pulse

    this.group = new THREE.Group();

    const bodyGeom = new THREE.SphereGeometry(0.34 * this.scale, 14, 10);
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 });
    this.bodyMesh = new THREE.InstancedMesh(bodyGeom, this.bodyMat, this.maxSamples);
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.frustumCulled = false;
    this.group.add(this.bodyMesh);

    const bellyGeom = new THREE.SphereGeometry(0.30 * this.scale, 12, 8);
    bellyGeom.scale(0.82, 0.5, 0.82);
    this.bellyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
    this.bellyMesh = new THREE.InstancedMesh(bellyGeom, this.bellyMat, this.maxSamples);
    this.bellyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bellyMesh.frustumCulled = false;
    this.group.add(this.bellyMesh);

    if (this.spiky) {
      const spikeGeom = new THREE.ConeGeometry(0.11 * this.scale, 0.3 * this.scale, 5);
      const c = new THREE.Color(opts.bodyColor).multiplyScalar(0.45);
      this.spikeMat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.1 });
      this.spikeMesh = new THREE.InstancedMesh(spikeGeom, this.spikeMat, this.maxSamples);
      this.spikeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.spikeMesh.castShadow = true;
      this.spikeMesh.frustumCulled = false;
      this.group.add(this.spikeMesh);
    }

    // Head: sphere + eyes + pupils, local +Z is forward.
    this.head = new THREE.Group();
    const headMat = new THREE.MeshStandardMaterial({ color: opts.headColor, roughness: 0.5, metalness: 0 });
    this.headMat = headMat;
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.4 * this.scale, 18, 14), headMat);
    headMesh.scale.set(1, 0.92, 1.08);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    const eyeGeom = new THREE.SphereGeometry(0.095 * this.scale, 10, 8);
    const pupilGeom = new THREE.SphereGeometry(0.05 * this.scale, 8, 6);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.25 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeom, eyeMat);
      eye.position.set(side * 0.19 * this.scale, 0.14 * this.scale, 0.3 * this.scale);
      const pupil = new THREE.Mesh(pupilGeom, pupilMat);
      pupil.position.set(0, 0.01 * this.scale, 0.07 * this.scale);
      eye.add(pupil);
      this.head.add(eye);
    }
    this.group.add(this.head);

    // Contact-shadow blob under the head.
    const blobGeom = new THREE.CircleGeometry(0.42 * this.scale, 20);
    blobGeom.rotateX(-Math.PI / 2);
    this.blob = new THREE.Mesh(blobGeom, SerpentView.blobMaterial || (SerpentView.blobMaterial =
      new THREE.MeshBasicMaterial({ color: 0x081008, transparent: true, opacity: 0.32, depthWrite: false })));
    this.blob.position.y = 0.012;
    this.group.add(this.blob);

    parent.add(this.group);

    // Instance color gradient (head bright, tail slightly darker).
    this._tmpM = new THREE.Matrix4();
    this._tmpP = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._tmpS = new THREE.Vector3();
    this._zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
    this._tmpC = new THREE.Color();
    this.setColors(opts.bodyColor, opts.bellyColor);
  }

  setColors(bodyHex, bellyHex) {
    const body = new THREE.Color(bodyHex);
    const belly = new THREE.Color(bellyHex);
    for (let s = 0; s < this.maxSamples; s++) {
      const f = 1 - 0.28 * (s / this.maxSamples);
      this._tmpC.copy(body).multiplyScalar(f);
      this.bodyMesh.setColorAt(s, this._tmpC);
      this.bellyMesh.setColorAt(s, belly);
    }
    this.bodyMesh.instanceColor.needsUpdate = true;
    this.bellyMesh.instanceColor.needsUpdate = true;
  }

  // Record a new immutable body snapshot (array of {x,y}, head first).
  setBody(body, tick, toWorld) {
    const n = Math.min(body.length, this.maxJoints);
    if (tick !== this.lastTick) {
      this.prev.set(this.cur);
      this.prevLen = this.curLen;
      this.lastTick = tick;
    }
    for (let i = 0; i < n; i++) toWorld(body[i].x, body[i].y, this.cur, i * 3);
    if (this.prevLen === 0) { // first sighting: no interpolation pop
      this.prev.set(this.cur);
      this.prevLen = n;
    }
    this.curLen = n;
  }

  kickTilt(amount) { this.tilt += amount; }
  kickWobble() { this.wobble = 1; }
  kickPulse(amount) { this.pulse = Math.max(this.pulse, amount); }

  update(alpha, dt) {
    const n = this.curLen;
    const visible = n > 0;
    this.group.visible = visible;
    if (!visible) return;

    // Interpolate joints; missing prev joints (growth) reuse the prev tail.
    const pl = Math.max(1, this.prevLen);
    for (let i = 0; i < n; i++) {
      const si = Math.min(i, pl - 1) * 3, ci = i * 3;
      this.work[ci] = this.prev[si] + (this.cur[ci] - this.prev[si]) * alpha;
      this.work[ci + 1] = this.baseY;
      this.work[ci + 2] = this.prev[si + 2] + (this.cur[ci + 2] - this.prev[ci + 2]) * alpha;
    }

    const w = this.work;
    const count = (n - 1) * SUB + 1;
    const taperDenom = Math.max(1, count - 1);
    for (let s = 0; s < this.maxSamples; s++) {
      if (s >= count) {
        this.bodyMesh.setMatrixAt(s, this._zeroM);
        this.bellyMesh.setMatrixAt(s, this._zeroM);
        if (this.spiky) this.spikeMesh.setMatrixAt(s, this._zeroM);
        continue;
      }
      const j = (s / SUB) | 0;
      const t = (s - j * SUB) / SUB;
      const i0 = Math.max(0, j - 1) * 3, i1 = j * 3;
      const i2 = Math.min(n - 1, j + 1) * 3, i3 = Math.min(n - 1, j + 2) * 3;
      const x = catmull(w[i0], w[i1], w[i2], w[i3], t);
      const z = catmull(w[i0 + 2], w[i1 + 2], w[i2 + 2], w[i3 + 2], t);
      const taper = 1 - 0.45 * (s / taperDenom);
      const r = taper;
      this._tmpP.set(x, this.baseY, z);
      this._tmpS.set(r, r, r);
      this._tmpM.compose(this._tmpP, this._tmpQ, this._tmpS);
      this.bodyMesh.setMatrixAt(s, this._tmpM);
      this._tmpP.set(x, this.baseY - 0.09 * this.scale, z);
      this._tmpM.compose(this._tmpP, this._tmpQ, this._tmpS);
      this.bellyMesh.setMatrixAt(s, this._tmpM);
      if (this.spiky) {
        this._tmpP.set(x, this.baseY + 0.34 * this.scale * r, z);
        this._tmpS.set(r, r, r);
        this._tmpM.compose(this._tmpP, this._tmpQ, this._tmpS);
        this.spikeMesh.setMatrixAt(s, this._tmpM);
      }
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.bellyMesh.instanceMatrix.needsUpdate = true;
    if (this.spiky) this.spikeMesh.instanceMatrix.needsUpdate = true;

    // Head pose: forward tangent from the curve, raised above the chain.
    const hx = w[0], hz = w[2];
    let tx = hx, tz = hz;
    if (n > 1) {
      const i0 = 0, i1 = 0, i2 = 3, i3 = Math.min(n - 1, 2) * 3;
      tx = catmull(w[i0], w[i1], w[i2], w[i3], 0.5);
      tz = catmull(w[i0 + 2], w[i1 + 2], w[i2 + 2], w[i3 + 2], 0.5);
    }
    const fx = hx - tx, fz = hz - tz;
    if (fx * fx + fz * fz > 1e-8) this.head.rotation.y = Math.atan2(fx, fz);

    // Input-ack tilt / invalid wobble / countdown pulse (critically damped decay).
    this.tilt *= Math.max(0, 1 - dt * 10);
    this.wobble = Math.max(0, this.wobble - dt * 3);
    this.pulse = Math.max(0, this.pulse - dt * 2.5);
    this.head.rotation.z = this.tilt;
    this.head.rotation.x = this.wobble > 0 ? Math.sin(this.wobble * 28) * 0.12 * this.wobble : 0;
    const ps = 1 + this.pulse * 0.18;
    this.head.scale.set(ps, ps, ps);

    const hy = this.baseY + 0.16 * this.scale;
    this.head.position.set(hx, hy, hz);
    this.blob.position.set(hx, 0.012, hz);
    this.headPos = this.headPos || { x: 0, y: 0, z: 0 };
    this.headPos.x = hx; this.headPos.y = hy; this.headPos.z = hz;
  }

  dispose() {
    this.group.removeFromParent();
    this.bodyMesh.geometry.dispose(); this.bodyMat.dispose(); this.bodyMesh.dispose();
    this.bellyMesh.geometry.dispose(); this.bellyMat.dispose(); this.bellyMesh.dispose();
    if (this.spiky) { this.spikeMesh.geometry.dispose(); this.spikeMat.dispose(); this.spikeMesh.dispose(); }
    this.head.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); if (o.material !== this.headMat) o.material.dispose(); }
    });
    this.headMat.dispose();
    this.blob.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Renderer factory
// ---------------------------------------------------------------------------

export function createRenderer(opts) {
  const canvas = opts.canvas;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 400);
  camera.layers.enable(LAYER_DECOR);
  camera.layers.enable(LAYER_MARKER);
  const shakeGroup = new THREE.Group(); // shake applied here; raycasts zero it
  shakeGroup.add(camera);
  scene.add(shakeGroup);

  // Lights (persist across arenas; recolored per theme).
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.castShadow = true;
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);
  scene.add(keyLight.target);
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334433, 0.8);
  scene.add(hemiLight);

  const camSpring = new Spring3();
  const lookSpring = new Spring3();

  const windUniforms = { uTime: { value: 0 }, uAmp: { value: 0.12 } };

  // ---- Module state ----
  let world = null;               // per-arena root group
  let particles = null;
  let groundMesh = null;
  let playerView = null;
  const rivalViews = new Map();
  let foodViews = [];
  let markerGroup = null;
  let previewRing = null, previewGhost = null;
  let hintArrows = null;          // { up, down, left, right } meshes
  let hintDirs = null;
  let previewPos = null;

  let config = null;
  let theme = null;
  let gridW = 0, gridH = 0;
  let lastState = null;
  let qualityTier = 'high';
  let paused = false;
  let hidden = false;
  let contextLost = false;
  let disposed = false;
  let simTime = 0;                // decorative clock (frozen when paused)
  let lastFrameT = -1;
  let trauma = 0;                 // camera shake energy
  let cameraViewApplied = '';
  let snapshotStamp = 0;
  let rafId = 0;

  // Scratch (hot-path reuse; no per-frame allocation)
  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _v3 = new THREE.Vector3();

  function readSettings() {
    try { return opts.getSettings() || {}; } catch (e) { return {}; }
  }

  function cellToWorld(x, y, out, offset) {
    out[offset] = (x - (gridW - 1) / 2) * CELL;
    out[offset + 1] = 0;
    out[offset + 2] = (y - (gridH - 1) / 2) * CELL;
  }

  function cellToWorldV(x, y, out) {
    out.set((x - (gridW - 1) / 2) * CELL, 0, (y - (gridH - 1) / 2) * CELL);
    return out;
  }

  // -------------------------------------------------------------------------
  // Arena construction
  // -------------------------------------------------------------------------

  function disposeWorld() {
    if (!world) return;
    playerView && playerView.dispose();
    playerView = null;
    for (const v of rivalViews.values()) v.dispose();
    rivalViews.clear();
    world.traverse((o) => {
      if (o.isMesh || o.isPoints) {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m !== SerpentView.blobMaterial) m.dispose();
        if (o.isInstancedMesh) o.dispose();
      }
    });
    world.removeFromParent();
    world = null;
    particles = null;
    groundMesh = null;
    foodViews = [];
    markerGroup = null;
    previewRing = previewGhost = null;
    hintArrows = null;
    hintDirs = null;
    previewPos = null;
  }

  function buildGround(rng) {
    const { ground, groundDark } = theme;
    const geom = new THREE.PlaneGeometry(gridW * CELL, gridH * CELL, gridW, gridH);
    geom.rotateX(-Math.PI / 2);
    const posAttr = geom.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);
    const cA = new THREE.Color(ground);
    const cB = new THREE.Color(groundDark);
    const c = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i), vz = posAttr.getZ(i);
      const cx = Math.floor(vx + gridW / 2), cy = Math.floor(vz + gridH / 2);
      const checker = ((cx + cy) % 2 + 2) % 2;
      const noise = rng() * 0.35;
      const f = Math.min(1, checker * 0.35 + noise);
      c.copy(cA).lerp(cB, f);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    groundMesh = new THREE.Mesh(geom, mat);
    groundMesh.receiveShadow = true;
    groundMesh.layers.set(LAYER_GAME);
    world.add(groundMesh);

    // Surrounding apron so the arena sits in a larger garden.
    const apronSize = Math.max(gridW, gridH) * 3.2;
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(apronSize, apronSize),
      new THREE.MeshStandardMaterial({ color: groundDark, roughness: 1 }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.03;
    apron.receiveShadow = true;
    world.add(apron);
  }

  function buildGrass(count, rng, obstacleSet) {
    // Tapered blade: 4-segment plane, narrower toward the tip.
    const geom = new THREE.PlaneGeometry(0.07, 0.5, 1, 3);
    geom.translate(0, 0.25, 0);
    const p = geom.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      p.setX(i, p.getX(i) * Math.max(0.08, 1 - y * 1.9));
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = windUniforms.uTime;
      shader.uniforms.uAmp = windUniforms.uAmp;
      shader.vertexShader = 'uniform float uTime;\nuniform float uAmp;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 windIP = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 windIP = vec3(0.0);
        #endif
        float windSway = sin(uTime * 1.7 + windIP.x * 1.9 + windIP.z * 2.6)
                       + 0.5 * sin(uTime * 2.9 + windIP.z * 3.7 + windIP.x);
        float windBend = position.y * position.y * 4.0;
        transformed.x += windSway * uAmp * windBend;
        transformed.z += windSway * uAmp * windBend * 0.6;
        `);
    };
    mat.customProgramCacheKey = () => 'sq-grass-wind';

    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.layers.set(LAYER_DECOR);
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const palette = theme.grass;
    let placed = 0;
    let guard = count * 8;
    while (placed < count && guard-- > 0) {
      const gx = Math.floor(rng() * gridW);
      const gy = Math.floor(rng() * gridH);
      if (obstacleSet.has(gx + ',' + gy)) continue;
      const x = (gx - (gridW - 1) / 2 + (rng() - 0.5) * 0.94) * CELL;
      const z = (gy - (gridH - 1) / 2 + (rng() - 0.5) * 0.94) * CELL;
      eul.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.25);
      q.setFromEuler(eul);
      const sc = 0.7 + rng() * 0.7;
      m.compose(v.set(x, 0, z), q, s.set(sc, sc * (0.8 + rng() * 0.6), sc));
      mesh.setMatrixAt(placed, m);
      c.set(palette[(rng() * palette.length) | 0]).multiplyScalar(0.85 + rng() * 0.3);
      mesh.setColorAt(placed, c);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    world.add(mesh);
  }

  function buildFlowers(count, rng, obstacleSet) {
    const stemGeom = new THREE.CylinderGeometry(0.02, 0.03, 0.34, 5);
    stemGeom.translate(0, 0.17, 0);
    const headGeom = new THREE.IcosahedronGeometry(0.09, 0);
    const stemMat = new THREE.MeshStandardMaterial({ color: theme.hedge, roughness: 0.9 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const stems = new THREE.InstancedMesh(stemGeom, stemMat, count);
    const heads = new THREE.InstancedMesh(headGeom, headMat, count);
    stems.layers.set(LAYER_DECOR);
    heads.layers.set(LAYER_DECOR);
    stems.frustumCulled = heads.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const c = new THREE.Color();
    const palette = theme.flowers;
    let placed = 0;
    let guard = count * 10;
    while (placed < count && guard-- > 0) {
      const gx = Math.floor(rng() * gridW);
      const gy = Math.floor(rng() * gridH);
      if (obstacleSet.has(gx + ',' + gy)) continue;
      const x = (gx - (gridW - 1) / 2 + (rng() - 0.5) * 0.9) * CELL;
      const z = (gy - (gridH - 1) / 2 + (rng() - 0.5) * 0.9) * CELL;
      const sc = 0.7 + rng() * 0.6;
      q.identity();
      m.compose(v.set(x, 0, z), q, s.set(sc, sc, sc));
      stems.setMatrixAt(placed, m);
      m.compose(v.set(x, 0.36 * sc, z), q, s.set(sc, sc, sc));
      heads.setMatrixAt(placed, m);
      c.set(palette[(rng() * palette.length) | 0]);
      heads.setColorAt(placed, c);
      placed++;
    }
    stems.count = heads.count = placed;
    stems.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
    if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
    world.add(stems);
    world.add(heads);
  }

  function buildHedgeWall(rng) {
    const perim = 2 * (gridW + 1) + 2 * (gridH + 1);
    const geom = new THREE.BoxGeometry(1.02, 0.55, 0.4);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    const mesh = new THREE.InstancedMesh(geom, mat, perim);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const base = new THREE.Color(theme.hedge);
    const halfW = gridW / 2, halfH = gridH / 2;
    let i = 0;
    const put = (x, z, rotY) => {
      eul.set(0, rotY, 0);
      q.setFromEuler(eul);
      m.compose(v.set(x, 0.24 + rng() * 0.08, z), q, s.set(1, 0.9 + rng() * 0.35, 1));
      mesh.setMatrixAt(i, m);
      c.copy(base).multiplyScalar(0.85 + rng() * 0.3);
      mesh.setColorAt(i, c);
      i++;
    };
    for (let x = 0; x < gridW + 1; x++) {
      put(x - halfW, -halfH - 0.35, 0);
      put(x - halfW, halfH - 0.5 + 0.85, 0);
    }
    for (let y = 0; y < gridH + 1; y++) {
      put(-halfW - 0.35, y - halfH, Math.PI / 2);
      put(halfW - 0.5 + 0.85, y - halfH, Math.PI / 2);
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    world.add(mesh);
  }

  function buildObstacles(cells) {
    if (!cells.length) return;
    const rocks = [[], [], []];
    const hedges = [];
    for (const cell of cells) {
      const h = hashCell(cell.x, cell.y, config.seed >>> 0);
      if (h % 5 < 3) rocks[h % 3].push({ cell, h });
      else hedges.push({ cell, h });
    }
    // Rock variants: icosahedra with deterministic radial deformation.
    const rockGeoms = [0, 1, 2].map((variant) => {
      const g = new THREE.IcosahedronGeometry(0.42, 1);
      const r = mulberry32((config.seed ^ (0x50c + variant * 7919)) >>> 0);
      const p = g.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const k = 0.78 + r() * 0.5;
        p.setXYZ(i, v.x * k, v.y * k * 0.72, v.z * k);
      }
      g.computeVertexNormals();
      return g;
    });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const rockBase = new THREE.Color(theme.rock);
    const blobGeom = new THREE.CircleGeometry(0.46, 18);
    blobGeom.rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x081008, transparent: true, opacity: 0.3, depthWrite: false });
    const blobs = new THREE.InstancedMesh(blobGeom, blobMat, cells.length);
    let blobCount = 0;

    rockGeoms.forEach((geom, gi) => {
      const list = rocks[gi];
      if (!list.length) { geom.dispose(); return; }
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
      const mesh = new THREE.InstancedMesh(geom, mat, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      list.forEach(({ cell, h }, i) => {
        const r = mulberry32(h);
        eul.set(0, r() * Math.PI * 2, 0);
        q.setFromEuler(eul);
        const sc = 0.8 + r() * 0.45;
        cellToWorldV(cell.x, cell.y, v); v.y = 0.1;
        m.compose(v, q, s.set(sc, sc, sc));
        mesh.setMatrixAt(i, m);
        c.copy(rockBase).multiplyScalar(0.85 + r() * 0.3);
        mesh.setColorAt(i, c);
        m.compose(v.set(v.x, 0.012, v.z), q.identity(), s.set(sc, 1, sc));
        blobs.setMatrixAt(blobCount++, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      world.add(mesh);
    });

    if (hedges.length) {
      const geom = new THREE.BoxGeometry(0.88, 0.6, 0.88);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
      const mesh = new THREE.InstancedMesh(geom, mat, hedges.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const hedgeBase = new THREE.Color(theme.hedge);
      hedges.forEach(({ cell, h }, i) => {
        const r = mulberry32(h);
        eul.set(0, (r() - 0.5) * 0.5, 0);
        q.setFromEuler(eul);
        const sc = 0.9 + r() * 0.25;
        cellToWorldV(cell.x, cell.y, v); v.y = 0.28;
        m.compose(v, q, s.set(sc, sc * (0.9 + r() * 0.3), sc));
        mesh.setMatrixAt(i, m);
        c.copy(hedgeBase).multiplyScalar(0.85 + r() * 0.3);
        mesh.setColorAt(i, c);
        m.compose(v.set(v.x, 0.012, v.z), q.identity(), s.set(sc, 1, sc));
        blobs.setMatrixAt(blobCount++, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      world.add(mesh);
    }

    blobs.count = blobCount;
    blobs.instanceMatrix.needsUpdate = true;
    world.add(blobs);
  }

  function makeFoodGeometries() {
    // Berry: small rounded cluster of three drupelets.
    const m1 = new THREE.Matrix4();
    const berry = mergeParts([
      { geom: new THREE.SphereGeometry(0.15, 10, 8), matrix: m1.makeTranslation(-0.09, 0.13, 0.02), color: 0xffffff },
      { geom: new THREE.SphereGeometry(0.15, 10, 8), matrix: m1.makeTranslation(0.09, 0.13, -0.02), color: 0xf2f2f2 },
      { geom: new THREE.SphereGeometry(0.16, 10, 8), matrix: m1.makeTranslation(0, 0.2, 0.06), color: 0xffffff },
      { geom: new THREE.ConeGeometry(0.05, 0.12, 5), matrix: m1.makeTranslation(0, 0.36, 0.06), color: 0x3f7a33 },
    ]);
    // Golden: glowing orb with a crown/star top — distinct silhouette.
    const spikes = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      spikes.push({
        geom: new THREE.ConeGeometry(0.05, 0.2, 4),
        matrix: new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.14, 0.42, Math.sin(a) * 0.14),
        color: 0xfff2c0,
      });
    }
    const golden = mergeParts([
      { geom: new THREE.SphereGeometry(0.2, 12, 10), matrix: new THREE.Matrix4().makeTranslation(0, 0.22, 0), color: 0xffffff },
      { geom: new THREE.TorusGeometry(0.15, 0.035, 6, 12), matrix: new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.34, 0), color: 0xffe9a0 },
      ...spikes,
    ]);
    return { berry, golden };
  }

  function buildFoodPool(palette) {
    const { berry, golden } = makeFoodGeometries();
    const berryMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.45,
      color: adjustForPalette(theme.food, 'food', palette),
    });
    const goldenMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.3,
      color: adjustForPalette(theme.foodGolden, 'foodGolden', palette),
      emissive: adjustForPalette(theme.foodGolden, 'foodGolden', palette),
      emissiveIntensity: 0.55,
    });
    foodViews = [];
    for (let i = 0; i < MAX_FOOD_VIEWS; i++) {
      const group = new THREE.Group();
      const b = new THREE.Mesh(berry, berryMat);
      const g = new THREE.Mesh(golden, goldenMat);
      b.castShadow = g.castShadow = true;
      group.add(b); group.add(g);
      group.visible = false;
      world.add(group);
      foodViews.push({ group, berry: b, golden: g, key: '', phase: 0, pop: 0, kind: 'berry' });
    }
  }

  function buildMarkers() {
    markerGroup = new THREE.Group();
    // Preview: grounded ring + lifted ghost quad.
    const ringGeom = new THREE.RingGeometry(0.3, 0.42, 28);
    ringGeom.rotateX(-Math.PI / 2);
    previewRing = new THREE.Mesh(ringGeom,
      new THREE.MeshBasicMaterial({ color: 0xfffbe0, transparent: true, opacity: 0.85, depthWrite: false }));
    previewRing.position.y = 0.02;
    const ghostGeom = new THREE.PlaneGeometry(0.86, 0.86);
    ghostGeom.rotateX(-Math.PI / 2);
    previewGhost = new THREE.Mesh(ghostGeom,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }));
    previewGhost.position.y = 0.08;
    previewRing.visible = previewGhost.visible = false;
    markerGroup.add(previewRing, previewGhost);

    // Hint arrows: small flat triangles at head cell edges.
    hintArrows = {};
    const arrowGeom = new THREE.ConeGeometry(0.16, 0.3, 3);
    arrowGeom.rotateX(Math.PI / 2); // point along +Z, flat-ish
    arrowGeom.scale(1, 0.35, 1);
    const dirs = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };
    for (const [name, rotY] of Object.entries(dirs)) {
      const mesh = new THREE.Mesh(arrowGeom,
        new THREE.MeshBasicMaterial({ color: 0xfffbe0, transparent: true, opacity: 0.55, depthWrite: false }));
      mesh.rotation.y = rotY;
      mesh.visible = false;
      markerGroup.add(mesh);
      hintArrows[name] = mesh;
    }
    markerGroup.traverse((o) => o.layers.set(LAYER_MARKER));
    world.add(markerGroup);
  }

  function applyThemeToLights() {
    scene.background = new THREE.Color(theme.sky);
    scene.fog = new THREE.Fog(theme.fog, cameraDistance() * 1.3, cameraDistance() * 3.4);
    keyLight.color.set(theme.sun);
    keyLight.intensity = theme.sunIntensity;
    hemiLight.color.set(theme.sky);
    hemiLight.groundColor.set(theme.groundDark);
    hemiLight.intensity = 0.75;
  }

  function positionLights() {
    const m = Math.max(gridW, gridH);
    keyLight.position.set(m * 0.7, m * 1.15, m * 0.45);
    keyLight.target.position.set(0, 0, 0);
    const ext = m * 0.85;
    const cam = keyLight.shadow.camera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 1; cam.far = m * 3;
    cam.updateProjectionMatrix();
    keyLight.shadow.mapSize.set(QUALITY_TIERS[qualityTier].shadowMap, QUALITY_TIERS[qualityTier].shadowMap);
    if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
  }

  function cameraDistance() {
    const aspect = camera.aspect || 1;
    const half = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    const fitV = (Math.max(gridW, gridH) * 0.55 + 1.6) / half;
    const fitH = (gridW * 0.55 + 1.6) / (half * aspect);
    return Math.max(fitV, fitH);
  }

  function cameraBaseTarget(out) {
    const dist = cameraDistance();
    const settings = readSettings();
    if (settings.cameraView === 'top') {
      out.set(0, dist * 1.5, 0.001);
    } else {
      out.set(0, dist * Math.sin(CAMERA_ELEVATION), dist * Math.cos(CAMERA_ELEVATION));
    }
    return out;
  }

  function buildScene(cfg, th) {
    disposeWorld();
    config = cfg;
    theme = th;
    gridW = cfg.grid.w;
    gridH = cfg.grid.h;
    world = new THREE.Group();
    scene.add(world);

    const rng = mulberry32((cfg.seed ^ 0xdec0) >>> 0);
    const obstacles = cfg.obstacles || [];
    const obstacleSet = new Set(obstacles.map((c) => c.x + ',' + c.y));
    const tier = QUALITY_TIERS[qualityTier];
    const palette = readSettings().colorPalette;

    buildGround(rng);
    buildGrass(tier.grass, rng, obstacleSet);
    buildFlowers(tier.flowers, rng, obstacleSet);
    buildHedgeWall(rng);
    buildObstacles(obstacles);
    buildFoodPool(palette);
    buildMarkers();

    particles = new ParticlePool(world);
    applyThemeToLights();
    positionLights();

    // Snap camera to the arena framing.
    cameraBaseTarget(_v3);
    camSpring.snap(_v3.x, _v3.y, _v3.z);
    lookSpring.snap(0, 0, 0);
    camera.up.set(0, 1, 0);
    cameraViewApplied = '';
    lastState = null;
    trauma = 0;
  }

  // -------------------------------------------------------------------------
  // Pointer input (tap steer / swipe steer / hover preview)
  // -------------------------------------------------------------------------

  let drag = null;

  function pickCell(clientX, clientY) {
    if (!groundMesh) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    // Zero the shake so raycasts always reflect the true board.
    const spx = shakeGroup.position.x, spy = shakeGroup.position.y, spz = shakeGroup.position.z;
    const srz = shakeGroup.rotation.z;
    shakeGroup.position.set(0, 0, 0);
    shakeGroup.rotation.set(0, 0, 0);
    camera.updateMatrixWorld(true);
    _raycaster.setFromCamera(_ndc, camera);
    _raycaster.layers.set(LAYER_GAME);
    const hit = _raycaster.intersectObject(groundMesh, false)[0];
    shakeGroup.position.set(spx, spy, spz);
    shakeGroup.rotation.z = srz;
    if (!hit) return null;
    _v3.copy(hit.point);
    const x = Math.floor(_v3.x / CELL + gridW / 2);
    const y = Math.floor(_v3.z / CELL + gridH / 2);
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return null;
    return { x, y };
  }

  function steerFromTap(cell) {
    if (!lastState || !lastState.snake.body.length) return;
    const head = lastState.snake.body[0];
    const dx = cell.x - head.x;
    const dy = cell.y - head.y;
    if (dx === 0 && dy === 0) return;
    let dir;
    if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    opts.onSteer(dir);
  }

  function onPointerDown(e) {
    if (!world || contextLost) return;
    if (drag) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), swiped: false };
  }

  function onPointerMove(e) {
    if (!world || contextLost) return;
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.hypot(dx, dy) >= SWIPE_MIN_DIST) {
        const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        opts.onSteer(dir);
        drag.sx = e.clientX;
        drag.sy = e.clientY;
        drag.swiped = true;
      }
    } else if (e.pointerType === 'mouse') {
      const cell = pickCell(e.clientX, e.clientY);
      if (cell) api.previewCell(cell.x, cell.y);
      else api.clearPreview();
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!world || contextLost) return;
    const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    const dt = performance.now() - d.t0;
    if (!d.swiped && dist <= TAP_MAX_DIST && dt <= TAP_MAX_MS) {
      const cell = pickCell(e.clientX, e.clientY);
      if (cell) {
        opts.onCellPicked(cell.x, cell.y);
        steerFromTap(cell);
      }
    }
  }

  function onPointerCancel(e) {
    if (drag && e.pointerId === drag.id) drag = null;
  }

  function onPointerLeave() {
    api.clearPreview();
  }

  function onContextLost(e) {
    e.preventDefault();
    contextLost = true;
    if (opts.onContextLost) opts.onContextLost();
  }

  function onContextRestored() {
    contextLost = false;
    renderer.state.reset();
    if (config && theme) buildScene(config, theme);
    if (lastState) api.syncSnapshot(lastState, 1);
    if (opts.onContextRestored) opts.onContextRestored();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  function updateCamera(dt) {
    const settings = readSettings();
    const view = settings.cameraView === 'top' ? 'top' : 'default';
    if (view !== cameraViewApplied) {
      cameraViewApplied = view;
      if (view === 'top') camera.up.set(0, 0, -1);
      else camera.up.set(0, 1, 0);
    }
    cameraBaseTarget(camSpring.t);

    // Gentle weighted follow of the interpolated head position.
    let lx = 0, lz = 0;
    if (playerView && playerView.headPos && lastState && lastState.snake.alive) {
      lx = playerView.headPos.x * CAMERA_FOLLOW;
      lz = playerView.headPos.z * CAMERA_FOLLOW;
      const len = Math.hypot(lx, lz);
      if (len > CAMERA_FOLLOW_MAX) { lx = (lx / len) * CAMERA_FOLLOW_MAX; lz = (lz / len) * CAMERA_FOLLOW_MAX; }
    }
    camSpring.t.x += lx;
    camSpring.t.z += lz;
    lookSpring.t.set(lx * 0.8, 0, lz * 0.8);

    camSpring.update(dt, SPRING_OMEGA);
    lookSpring.update(dt, SPRING_OMEGA);
    camera.position.copy(camSpring.p);
    camera.lookAt(lookSpring.p);

    // Event-tiered shake on the rig child; raycasts zero it out.
    trauma = Math.max(0, trauma - dt * 1.1);
    if (trauma > 0 && !settings.reducedMotion) {
      const s = trauma * trauma;
      const t = simTime * 31;
      shakeGroup.position.set(Math.sin(t * 1.1) * 0.16 * s, Math.sin(t * 1.7 + 2) * 0.12 * s, 0);
      shakeGroup.rotation.z = Math.sin(t * 1.3 + 4) * 0.015 * s;
    } else {
      shakeGroup.position.set(0, 0, 0);
      shakeGroup.rotation.set(0, 0, 0);
    }
  }

  function updateDecor(dt) {
    const settings = readSettings();
    windUniforms.uTime.value = simTime;
    windUniforms.uAmp.value = 0.12 * (settings.reducedMotion ? 0.05 : 1);

    const bobAmp = settings.reducedMotion ? 0.018 : 0.06;
    for (const fv of foodViews) {
      if (!fv.group.visible) continue;
      fv.pop = Math.max(0, fv.pop - dt * 2.2);
      const base = fv.group.userData.baseY || 0;
      fv.group.position.y = base + Math.sin(simTime * 2.2 + fv.phase) * bobAmp;
      const sc = 1 + fv.pop * 0.55 + (fv.kind === 'golden' ? Math.sin(simTime * 3 + fv.phase) * 0.05 : 0);
      fv.group.scale.set(sc, sc, sc);
      if (fv.kind === 'golden') {
        fv.golden.material.emissiveIntensity = 0.5 + Math.sin(simTime * 3.1 + fv.phase) * 0.2;
      }
    }

    if (previewRing && previewRing.visible) {
      const p = 1 + Math.sin(simTime * 5) * 0.07;
      previewRing.scale.set(p, 1, p);
    }
    if (hintArrows && hintDirs) {
      const pulse = 0.45 + Math.sin(simTime * 4) * 0.15;
      for (const name of hintDirs) if (hintArrows[name]) hintArrows[name].material.opacity = pulse;
    }

    if (particles) particles.update(dt);
  }

  function frame(tMs) {
    rafId = requestAnimationFrame(frame);
    if (disposed) return;
    if (hidden || contextLost) { lastFrameT = tMs; return; }
    const dt = lastFrameT < 0 ? 0.016 : Math.min(0.05, (tMs - lastFrameT) / 1000);
    lastFrameT = tMs;
    if (!paused) simTime += dt;

    updateCamera(dt);
    if (!paused) updateDecor(dt);
    if (world) renderer.render(scene, camera);
  }
  rafId = requestAnimationFrame(frame);

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const api = {
    loadArena(cfg, th) {
      buildScene(cfg, th);
      api.resize();
    },

    syncSnapshot(state, alpha) {
      if (!world || !state) return;
      const a = alpha === undefined ? 1 : Math.min(1, Math.max(0, alpha));
      lastState = state;
      const palette = readSettings().colorPalette;

      if (!playerView) {
        playerView = new SerpentView(world, {
          scale: 1, spiky: false, maxJoints: MAX_JOINTS,
          headColor: theme.snakeHead, bodyColor: theme.snakeBody, bellyColor: theme.snakeBelly,
        });
      }
      playerView.setBody(state.snake.body, state.tick, cellToWorld);
      playerView.update(a, 0.016);

      snapshotStamp++;
      for (const r of state.rivals) {
        let view = rivalViews.get(r.id);
        if (!view) {
          const big = r.tier === 'big';
          view = new SerpentView(world, {
            scale: big ? 1.3 : 0.72,
            spiky: big,
            maxJoints: RIVAL_MAX_JOINTS,
            headColor: adjustForPalette(big ? theme.rivalBig : theme.rivalSmall, big ? 'rivalBig' : 'rivalSmall', palette),
            bodyColor: adjustForPalette(big ? theme.rivalBig : theme.rivalSmall, big ? 'rivalBig' : 'rivalSmall', palette),
            bellyColor: theme.snakeBelly,
          });
          rivalViews.set(r.id, view);
        }
        if (!r.alive || !r.body.length) { view.group.visible = false; view._stamp = snapshotStamp; continue; }
        view.setBody(r.body, state.tick, cellToWorld);
        view.update(a, 0.016);
        view._stamp = snapshotStamp;
      }
      for (const [id, view] of rivalViews) {
        if (view._stamp !== snapshotStamp) { view.dispose(); rivalViews.delete(id); }
      }

      // Food pool reconcile (fixed pool, rebuild only on key change).
      for (let i = 0; i < foodViews.length; i++) {
        const fv = foodViews[i];
        const f = state.food[i];
        if (!f) { fv.group.visible = false; fv.key = ''; continue; }
        const key = f.x + ',' + f.y + ',' + f.kind;
        if (fv.key !== key) {
          fv.key = key;
          fv.kind = f.kind;
          fv.berry.visible = f.kind === 'berry';
          fv.golden.visible = f.kind === 'golden';
          cellToWorldV(f.x, f.y, fv.group.position);
          fv.group.userData.baseY = 0;
          fv.phase = (hashCell(f.x, f.y, 0xfeed) % 628) / 100;
          fv.pop = 1; // spawn pop
        }
        fv.group.visible = true;
      }

      // Hint arrows follow the interpolated head.
      if (hintArrows && hintDirs && playerView.headPos) {
        const hp = playerView.headPos;
        const off = 0.48;
        for (const [name, mesh] of Object.entries(hintArrows)) {
          if (!mesh.visible) continue;
          if (name === 'up') mesh.position.set(hp.x, 0.05, hp.z - off);
          else if (name === 'down') mesh.position.set(hp.x, 0.05, hp.z + off);
          else if (name === 'left') mesh.position.set(hp.x - off, 0.05, hp.z);
          else mesh.position.set(hp.x + off, 0.05, hp.z);
        }
      }
    },

    playEvent(event) {
      if (!world || !event) return;
      const settings = readSettings();
      const countScale = QUALITY_TIERS[qualityTier].particleScale * (settings.reducedMotion ? 0.5 : 1);
      const cellV = (cell) => cellToWorldV(cell.x, cell.y, _v3);

      switch (event.type) {
        case 'turn':
          if (playerView) playerView.kickTilt(event.dir === 'left' || event.dir === 'down' ? 0.16 : -0.16);
          break;
        case 'eat': {
          const p = cellV(event.cell);
          const col = event.kind === 'golden' ? theme.foodGolden : theme.food;
          particles && particles.burst(p.x, 0.2, p.z, col, 0, countScale);
          break;
        }
        case 'grow': {
          if (playerView && playerView.headPos && particles) {
            const hp = playerView.headPos;
            particles.burst(hp.x, 0.2, hp.z, theme.grass[2] || theme.grass[0], 1, countScale);
          }
          break;
        }
        case 'rival-defeated': {
          const p = cellV(event.cell);
          particles && particles.burst(p.x, 0.25, p.z, theme.rivalSmall, 1, countScale);
          break;
        }
        case 'death': {
          if (event.cell) {
            const p = cellV(event.cell);
            particles && particles.burst(p.x, 0.3, p.z, theme.food, 2, countScale);
          }
          if (!settings.reducedMotion) trauma = Math.min(1, trauma + 0.75);
          break;
        }
        case 'win': {
          if (event.cell) {
            const p = cellV(event.cell);
            particles && particles.burst(p.x, 0.3, p.z, theme.foodGolden, 2, countScale);
          }
          if (!settings.reducedMotion) {
            trauma = Math.min(1, trauma + 0.35);
            camSpring.v.y += 1.2; // gentle upward accent kick
          }
          break;
        }
        case 'invalid':
          if (playerView) playerView.kickWobble();
          break;
        case 'undo': {
          if (playerView && playerView.headPos && particles) {
            const hp = playerView.headPos;
            particles.burst(hp.x, 0.2, hp.z, theme.water, 0, countScale * 0.6);
          }
          break;
        }
        case 'countdown':
          if (playerView) playerView.kickPulse(0.7);
          break;
        case 'go':
          if (playerView) playerView.kickPulse(1);
          if (playerView && playerView.headPos && particles) {
            const hp = playerView.headPos;
            particles.burst(hp.x, 0.2, hp.z, 0xffffff, 0, countScale);
          }
          break;
        default:
          break;
      }
    },

    previewCell(x, y) {
      if (!previewRing) return;
      cellToWorldV(x, y, _v3);
      previewRing.position.set(_v3.x, 0.02, _v3.z);
      previewGhost.position.set(_v3.x, 0.08, _v3.z);
      previewRing.visible = previewGhost.visible = true;
      previewPos = { x, y };
    },

    clearPreview() {
      if (!previewRing) return;
      previewRing.visible = previewGhost.visible = false;
      previewPos = null;
    },

    showHint(dirs) {
      if (!hintArrows) return;
      hintDirs = dirs || [];
      for (const [name, mesh] of Object.entries(hintArrows)) {
        mesh.visible = hintDirs.includes(name);
      }
    },

    clearHint() {
      if (!hintArrows) return;
      hintDirs = null;
      for (const mesh of Object.values(hintArrows)) mesh.visible = false;
    },

    projectCell(x, y) {
      cellToWorldV(x, y, _v3);
      const spx = shakeGroup.position.x, spy = shakeGroup.position.y, spz = shakeGroup.position.z;
      const srz = shakeGroup.rotation.z;
      shakeGroup.position.set(0, 0, 0);
      shakeGroup.rotation.set(0, 0, 0);
      camera.updateMatrixWorld(true);
      _v3.project(camera);
      shakeGroup.position.set(spx, spy, spz);
      shakeGroup.rotation.z = srz;
      return {
        x: (_v3.x * 0.5 + 0.5) * canvas.clientWidth,
        y: (-_v3.y * 0.5 + 0.5) * canvas.clientHeight,
      };
    },

    setQuality(tier) {
      if (!QUALITY_TIERS[tier] || tier === qualityTier) return;
      qualityTier = tier;
      api.resize();
      applyQualityFlags();
      if (config && theme) {
        const keepState = lastState;
        buildScene(config, theme); // rebuild instanced decor at new density
        if (keepState) api.syncSnapshot(keepState, 1);
      }
    },

    setTheme(th) {
      if (!config) { theme = th; return; }
      const keepState = lastState;
      buildScene(config, th); // recolor via rebuild (explicitly allowed)
      if (keepState) api.syncSnapshot(keepState, 1);
    },

    setPaused(value) { paused = !!value; },
    setHidden(value) { hidden = !!value; },

    resize() {
      const w = canvas.clientWidth || canvas.width || 1;
      const h = canvas.clientHeight || canvas.height || 1;
      const dprCap = QUALITY_TIERS[qualityTier].dpr;
      const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, dprCap);
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (world) applyThemeToLights(); // refresh fog distances for new framing
    },

    prewarm() {
      if (!world || contextLost) return;
      const wasHidden = hidden;
      hidden = false;
      renderer.compile(scene, camera);
      renderer.render(scene, camera); // one full frame: shadow map + programs
      hidden = wasHidden;
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      disposeWorld();
      if (SerpentView.blobMaterial) { SerpentView.blobMaterial.dispose(); SerpentView.blobMaterial = null; }
      keyLight.dispose();
      hemiLight.dispose();
      renderer.dispose();
    },
  };

  function applyQualityFlags() {
    const tier = QUALITY_TIERS[qualityTier];
    renderer.shadowMap.enabled = tier.shadows;
    keyLight.castShadow = tier.shadows;
    scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
  }

  return api;
}
