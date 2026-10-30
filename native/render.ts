// The garden arena on starhermit:scene, as the browser build's js/render.js
// drew it with three.js r160: the checkered ground with its mottled texture
// and bump (Detail on) on a larger apron, wind-swayed grass blades (a vertex
// hook in place of onBeforeCompile), flowers, the hedge wall, the rock and
// hedge obstacles with their blob shadows, the serpents (an instanced chain
// of spheres along a Catmull-Rom curve through the tick-interpolated cells,
// belly, spiky plates on big rivals, the head with eyes, the head's blob
// shadow, turn tilt / invalid wobble / countdown pulse), the bobbing berries
// and glowing golden fruit, the hover preview ring and the hint arrows, the
// pooled particle bursts and the drifting pollen, the sun with shadows, the
// sky-tinted hemisphere fill, the fog, the room environment's reflections,
// the camera on critically damped springs following the head a little, and
// the event shake. Per quality tier the old presets' budgets (native/
// quality.ts): Lambert / Standard / clear-coated Physical shading, foliage
// density, sphere segments, particle pools, shadows, GTAO, bloom, the grade
// and the anti-aliasing.
//
// From three.js r160 (physically based lights): colours and intensities as
// written; RoomEnvironment(renderer) as the old page made it, each material
// with the environment as its own envMap at its old envMapIntensity (the
// scene environment ignores per-material intensities). r160's composer drew
// the scene in linear half floats, ran GTAO, bloomed it (0.35 / 0.35 /
// threshold 0.92), graded it in linear light (GradeShader, before the
// OutputPass), tone-mapped it (ACES) and anti-aliased it: the runtime's
// renderer.ao / bloom / grade / antialias do the same in that order. The
// old canvas sat between the rails under the top bar: the camera keeps that
// playfield's aspect and is offset into it (setViewOffset). The directional
// shadow's ortho box is fitted to the arena in light space as the old page
// did; bloom strength is squared for r185's UnrealBloomPass. Adaptive resolution, the pixel-ratio cap
// and the frame-rate readout are the runtime's. Rendering never touches the
// rules state.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry,
  CylinderGeometry, DirectionalLight, DoubleSide, Euler, Float32BufferAttribute, Fog, Group, HemisphereLight, IcosahedronGeometry,
  InstancedMesh, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  NoColorSpace, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping,
  RingGeometry, RoomEnvironment, SphereGeometry, TextureLoader, TorusGeometry, Vector3, pointerToNdc, renderer, scene,
  SRGBColorSpace, type Material, type MaterialHooks, type Object3D, type OrthographicCamera, type Texture,
} from "starhermit:scene";
import type { Cell, Dir, GameEvent, RulesConfig, State, Theme } from "./game.ts";
import { PARTICLE_SCALE, flowerCount, grassCount, type Look } from "./quality.ts";

export interface Rect { x: number; y: number; width: number; height: number }

const CELL = 1;
const CAMERA_FOV = 35;
const CAMERA_ELEVATION = 0.92;
const CAMERA_FOLLOW = 0.12;
const CAMERA_FOLLOW_MAX = 1.4;
const SPRING_OMEGA = 5.2;
const MAX_JOINTS = 384;
const RIVAL_MAX_JOINTS = 64;
const SUB = 2;
const MAX_FOOD_VIEWS = 16;
const MAX_PARTICLES = 640;

// ---------------------------------------------------------------- decoration randomness (never rules state)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashCell(x: number, y: number, seed: number): number {
  let h = (seed >>> 0) ^ Math.imul(x + 0x9e3779b9, 374761393) ^ Math.imul(y + 0x85ebca6b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** render.js adjustForPalette: gameplay hues and luminance per colour-vision palette (presentation only). */
export function adjustForPalette(hex: number, role: string, palette: string): number {
  if (!palette || palette === "standard") return hex;
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  let { h, l } = hsl;
  const s = hsl.s;
  if (palette === "deuteranopia" || palette === "protanopia") {
    if (h < 0.16 || h > 0.9) h = (h + 0.5) % 1;
    if (role === "food" || role === "foodGolden") l = Math.min(0.72, l + 0.18);
    if (role === "rivalSmall") l = Math.min(0.62, l + 0.1);
    if (role === "rivalBig") l = Math.max(0.13, l * 0.45);
  } else if (palette === "tritanopia") {
    if (h > 0.09 && h < 0.24) h = 0.93;
    if (role === "foodGolden") l = Math.min(0.7, l + 0.12);
    if (role === "rivalBig") l = Math.max(0.13, l * 0.5);
  }
  c.setHSL(h, Math.min(1, s), l);
  return c.getHex();
}

/** render.js mergeParts: simple parts (geometry + matrix + flat colour) as one non-indexed vertex-coloured geometry. */
function mergeParts(parts: { geom: BufferGeometry; matrix: Matrix4; color: number }[]): BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const nMat = new Matrix3(), v = new Vector3(), col = new Color();
  for (const part of parts) {
    const g = part.geom.index ? part.geom.toNonIndexed() : part.geom;
    const pos = g.getAttribute("position") as BufferAttribute, nor = g.getAttribute("normal") as BufferAttribute;
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
    part.geom.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(positions, 3));
  out.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  out.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return out;
}
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// ---------------------------------------------------------------- the detail textures (tools/bake-textures.mjs)
interface DetailTex { ground: Texture; groundBump: Texture; leaf: Texture; leafBump: Texture; scales: Texture }
const loader = new TextureLoader();
const texBySize = new Map<number, DetailTex>();
let dotTex: Texture | null = null;
function loadTex(path: string, color: boolean): Texture {
  const t = loader.load(path, undefined, undefined, (e: unknown) => console.warn(`texture ${path}: ${e instanceof Error ? e.message : String(e)}`));
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace; // as render.js's canvasTexture(…, srgb)
  return t;
}
function detailTextures(size: number): DetailTex {
  let t = texBySize.get(size);
  if (!t) {
    t = {
      ground: loadTex(`assets/textures/ground-${size}.png`, true), groundBump: loadTex(`assets/textures/ground-bump-${size}.png`, false),
      leaf: loadTex(`assets/textures/leaf-${size}.png`, true), leafBump: loadTex(`assets/textures/leaf-bump-${size}.png`, false),
      scales: loadTex(`assets/textures/scales-${size}.png`, false),
    };
    texBySize.set(size, t);
  }
  return t;
}
function dot(): Texture {
  if (!dotTex) dotTex = loader.load("assets/textures/dot.png");
  return dotTex;
}
/** A repeat of a shared texture (render.js cloned the texture per material for its own repeat). */
function repeated(tex: Texture, rx: number, ry: number): Texture {
  const t = tex.clone();
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- the fixed parts
const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 400);
const shakeGroup = new Group();
shakeGroup.add(camera);
scene.add(shakeGroup);
// r160 physical intensities as written (the theme sets the sun's).
const keyLight = new DirectionalLight(0xffffff, 2);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight, keyLight.target);
const hemiLight = new HemisphereLight(0xffffff, 0x334433, 0.8);
scene.add(hemiLight);
const raycaster = new Raycaster();
const windU = { uTime: { value: 0 }, uAmp: { value: 0.12 } };
// render.js grass onBeforeCompile: sway by the instance's position, bending with the blade's height².
const WIND_VERT = /* wgsl */ `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let ip = (model_matrix() * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  let sway = sin(uniforms.uTime * 1.7 + ip.x * 1.9 + ip.z * 2.6) + 0.5 * sin(uniforms.uTime * 2.9 + ip.z * 3.7 + ip.x);
  let bend = v.position.y * v.position.y * 4.0;
  o.position.x = v.position.x + sway * uniforms.uAmp * bend;
  o.position.z = v.position.z + sway * uniforms.uAmp * bend * 0.6;
  return o;
}`;

let look: Look | null = null;
let palette = "standard";
let reducedMotion = false;
let cameraView = "default";
let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!look?.reflections) return null;
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}

type Params = { color?: number | Color; roughness?: number; metalness?: number; envMapIntensity?: number; vertexColors?: boolean;
  map?: Texture | null; bumpMap?: Texture | null; bumpScale?: number; side?: typeof DoubleSide; flatShading?: boolean; emissive?: number; emissiveIntensity?: number;
  clearcoat?: number; clearcoatRoughness?: number };
/** The preset budget's shading (render.js shadeTree): Lambert on Low, Standard on Balanced, Physical (clear coat) on High / Ultra. */
function surface(p: Params, physical = false): Material {
  const tier = look!.budget.material;
  const base: Record<string, unknown> = {};
  for (const k of ["color", "vertexColors", "map", "bumpMap", "bumpScale", "side", "flatShading", "emissive", "emissiveIntensity"] as const) if (p[k] !== undefined && p[k] !== null) base[k] = p[k];
  if (tier === "lambert") { delete base.bumpMap; delete base.bumpScale; return new MeshLambertMaterial(base); }
  const std: Record<string, unknown> = { ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 };
  const env = envMap();
  if (env) { std.envMap = env; std.envMapIntensity = p.envMapIntensity ?? 1; }
  if (physical && tier === "physical") return new MeshPhysicalMaterial({ ...std, clearcoat: p.clearcoat ?? 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(std);
}

// ---------------------------------------------------------------- particles and pollen
class ParticlePool {
  readonly points: Points;
  private readonly pos: Float32Array; private readonly col: Float32Array; private readonly base: Float32Array;
  private readonly vel: Float32Array; private readonly life: Float32Array; private readonly maxLife: Float32Array;
  private cursor = 0;
  private active = false;
  private readonly share: number;
  private readonly rand = mulberry32(0x5eed);
  readonly material: PointsMaterial;
  constructor(parent: Object3D, readonly max: number, detailed: boolean) {
    this.share = max / MAX_PARTICLES;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.base = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1000;
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(this.pos, 3));
    geom.setAttribute("color", new BufferAttribute(this.col, 3));
    this.material = new PointsMaterial({
      size: detailed ? 0.22 : 0.14, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending,
      sizeAttenuation: true, map: detailed ? dot() : null,
    });
    this.points = new Points(geom, this.material);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }
  /** tier 0 small (eat), 1 medium (grow / rival), 2 large (win / death). */
  burst(x: number, y: number, z: number, hex: number, tier: 0 | 1 | 2, countScale: number): void {
    const n = Math.round([12, 30, 90][tier]! * countScale * this.share);
    const c = new Color(hex);
    const speed = [1.6, 2.6, 4.2][tier]!, up = [2.2, 3.2, 5.0][tier]!, lifeBase = [0.45, 0.6, 0.9][tier]!;
    const r = this.rand;
    for (let i = 0; i < n; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const a = r() * Math.PI * 2, m = (0.3 + r() * 0.7) * speed;
      this.pos[idx * 3] = x; this.pos[idx * 3 + 1] = y + 0.15; this.pos[idx * 3 + 2] = z;
      this.vel[idx * 3] = Math.cos(a) * m; this.vel[idx * 3 + 1] = up * (0.4 + r() * 0.8); this.vel[idx * 3 + 2] = Math.sin(a) * m;
      const shade = 0.7 + r() * 0.5;
      this.base[idx * 3] = c.r * shade; this.base[idx * 3 + 1] = c.g * shade; this.base[idx * 3 + 2] = c.b * shade;
      this.maxLife[idx] = this.life[idx] = lifeBase * (0.6 + r() * 0.7);
    }
    this.active = true;
  }
  update(dt: number): void {
    if (!this.active) return;
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      const i3 = i * 3;
      if (this.life[i]! <= 0) { this.pos[i3 + 1] = -1000; this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0; continue; }
      this.vel[i3 + 1]! -= 7.5 * dt;
      this.pos[i3]! += this.vel[i3]! * dt; this.pos[i3 + 1]! += this.vel[i3 + 1]! * dt; this.pos[i3 + 2]! += this.vel[i3 + 2]! * dt;
      if (this.pos[i3 + 1]! < 0.02) { this.pos[i3 + 1] = 0.02; this.vel[i3 + 1]! *= -0.3; }
      const f = this.life[i]! / this.maxLife[i]!;
      this.col[i3] = this.base[i3]! * f; this.col[i3 + 1] = this.base[i3 + 1]! * f; this.col[i3 + 2] = this.base[i3 + 2]! * f;
    }
    this.active = any;
    (this.points.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
  }
}
class PollenField {
  readonly points: Points;
  private readonly base: Float32Array; private readonly pos: Float32Array;
  readonly material: PointsMaterial;
  constructor(parent: Object3D, w: number, h: number, hex: number, readonly n: number) {
    this.base = new Float32Array(n * 4); this.pos = new Float32Array(n * 3);
    const r = mulberry32(0x9011e);
    for (let i = 0; i < n; i++) {
      this.base[i * 4] = (r() - 0.5) * (w + 2); this.base[i * 4 + 1] = 0.25 + r() * 1.6;
      this.base[i * 4 + 2] = (r() - 0.5) * (h + 2); this.base[i * 4 + 3] = r() * 100;
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.material = new PointsMaterial({
      size: 0.09, map: dot(), color: new Color(hex).lerp(new Color(0xffffff), 0.5).multiplyScalar(1.3),
      transparent: true, opacity: 0.75, depthWrite: false, blending: AdditiveBlending,
    });
    this.points = new Points(geom, this.material);
    this.points.frustumCulled = false;
    parent.add(this.points);
    this.update(0);
  }
  update(t: number): void {
    const b = this.base, p = this.pos;
    for (let i = 0; i < this.n; i++) {
      const k = t * 0.35 + b[i * 4 + 3]!;
      p[i * 3] = b[i * 4]! + Math.sin(k * 0.7) * 0.9 + Math.sin(k * 1.9) * 0.2;
      p[i * 3 + 1] = b[i * 4 + 1]! + Math.sin(k * 1.3) * 0.25;
      p[i * 3 + 2] = b[i * 4 + 2]! + Math.cos(k * 0.55) * 0.9;
    }
    (this.points.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
  }
}

// ---------------------------------------------------------------- the serpents (render.js SerpentView)
let blobMaterial: MeshBasicMaterial | null = null;
interface SerpentOpts { scale: number; spiky: boolean; maxJoints: number; detail: boolean; texture: number; body: number; headColor: number; bodyColor: number; bellyColor: number }
class SerpentView {
  readonly group = new Group();
  readonly head = new Group();
  headPos = { x: 0, y: 0, z: 0 };
  stamp = 0;
  private readonly scale: number; private readonly spiky: boolean; private readonly maxJoints: number; private readonly maxSamples: number;
  private readonly baseY: number;
  private prev: Float32Array; private cur: Float32Array; private work: Float32Array;
  private prevLen = 0; private curLen = 0; private lastTick = -1;
  private tilt = 0; private wobble = 0; private pulse = 0;
  private readonly bodyMesh: InstancedMesh; private readonly bellyMesh: InstancedMesh; private readonly spikeMesh: InstancedMesh | null = null;
  private readonly blob: Mesh;
  private readonly mats: Material[] = [];
  private readonly m = new Matrix4(); private readonly p = new Vector3(); private readonly q = new Quaternion(); private readonly s = new Vector3();
  private readonly zero = new Matrix4().makeScale(0, 0, 0);
  constructor(parent: Object3D, o: SerpentOpts) {
    this.scale = o.scale; this.spiky = o.spiky; this.maxJoints = o.maxJoints;
    this.maxSamples = (this.maxJoints - 1) * SUB + 1;
    this.baseY = 0.3 * this.scale;
    this.prev = new Float32Array(this.maxJoints * 3); this.cur = new Float32Array(this.maxJoints * 3); this.work = new Float32Array(this.maxJoints * 3);
    const tex = o.detail ? detailTextures(o.texture) : null;
    const skin = (color: number, roughness: number, metalness: number, clear: number): Material => {
      const m = surface({ color, roughness: tex ? Math.max(0.3, roughness - 0.15) : roughness, metalness, envMapIntensity: 0.14, clearcoat: clear, clearcoatRoughness: 0.3 }, !!tex);
      this.mats.push(m);
      return m;
    };
    const seg = o.body, ring = Math.max(6, Math.round(seg * 0.7));
    const bodyMat = skin(0xffffff, 0.55, 0, 0.4);
    if (tex && !(bodyMat instanceof MeshLambertMaterial)) {
      const bm = bodyMat as MeshStandardMaterial;
      bm.bumpMap = repeated(tex.scales, 4, 2);
      bm.bumpScale = 1.4;
    }
    this.bodyMesh = new InstancedMesh(new SphereGeometry(0.34 * this.scale, seg, ring), bodyMat, this.maxSamples);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.frustumCulled = false;
    this.group.add(this.bodyMesh);
    const bellyGeom = new SphereGeometry(0.3 * this.scale, Math.min(12, seg), Math.min(8, ring));
    bellyGeom.scale(0.82, 0.5, 0.82);
    this.bellyMesh = new InstancedMesh(bellyGeom, skin(0xffffff, 0.7, 0, 0.2), this.maxSamples);
    this.bellyMesh.frustumCulled = false;
    this.group.add(this.bellyMesh);
    if (this.spiky) {
      const c = new Color(o.bodyColor).multiplyScalar(0.45);
      this.spikeMesh = new InstancedMesh(new ConeGeometry(0.11 * this.scale, 0.3 * this.scale, 5), skin(c.getHex(), 0.5, 0.1, 0.4), this.maxSamples);
      this.spikeMesh.castShadow = true;
      this.spikeMesh.frustumCulled = false;
      this.group.add(this.spikeMesh);
    }
    const headMesh = new Mesh(new SphereGeometry(0.4 * this.scale, Math.max(12, seg), Math.max(10, ring)), skin(o.headColor, 0.5, 0, 0.5));
    headMesh.scale.set(1, 0.92, 1.08);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    const eyeGeom = new SphereGeometry(0.095 * this.scale, 10, 8), pupilGeom = new SphereGeometry(0.05 * this.scale, 8, 6);
    const eyeMat = skin(0xffffff, 0.3, 0, 1), pupilMat = skin(0x14181c, 0.25, 0, 1);
    for (const side of [-1, 1]) {
      const eye = new Mesh(eyeGeom, eyeMat);
      eye.position.set(side * 0.19 * this.scale, 0.14 * this.scale, 0.3 * this.scale);
      const pupil = new Mesh(pupilGeom, pupilMat);
      pupil.position.set(0, 0.01 * this.scale, 0.07 * this.scale);
      eye.add(pupil);
      this.head.add(eye);
    }
    this.group.add(this.head);
    const blobGeom = new CircleGeometry(0.42 * this.scale, 20);
    blobGeom.rotateX(-Math.PI / 2);
    blobMaterial ??= new MeshBasicMaterial({ color: 0x081008, transparent: true, opacity: 0.32, depthWrite: false });
    this.blob = new Mesh(blobGeom, blobMaterial);
    this.blob.position.y = 0.012;
    this.group.add(this.blob);
    parent.add(this.group);
    // Instance colour gradient (head bright, tail slightly darker).
    const body = new Color(o.bodyColor), belly = new Color(o.bellyColor), c = new Color();
    for (let s = 0; s < this.maxSamples; s++) {
      c.copy(body).multiplyScalar(1 - 0.28 * (s / this.maxSamples));
      this.bodyMesh.setColorAt(s, c);
      this.bellyMesh.setColorAt(s, belly);
    }
    if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
    if (this.bellyMesh.instanceColor) this.bellyMesh.instanceColor.needsUpdate = true;
  }
  setBody(body: Cell[], tick: number): void {
    const n = Math.min(body.length, this.maxJoints);
    if (tick !== this.lastTick) {
      this.prev.set(this.cur);
      this.prevLen = this.curLen;
      this.lastTick = tick;
    }
    for (let i = 0; i < n; i++) cellToWorld(body[i]!.x, body[i]!.y, this.cur, i * 3);
    if (this.prevLen === 0) { this.prev.set(this.cur); this.prevLen = n; }
    this.curLen = n;
  }
  kickTilt(a: number): void { this.tilt += a; }
  kickWobble(): void { this.wobble = 1; }
  kickPulse(a: number): void { this.pulse = Math.max(this.pulse, a); }
  update(alpha: number, dt: number): void {
    const n = this.curLen;
    this.group.visible = n > 0;
    if (!n) return;
    const pl = Math.max(1, this.prevLen);
    const w = this.work;
    for (let i = 0; i < n; i++) {
      const si = Math.min(i, pl - 1) * 3, ci = i * 3;
      w[ci] = this.prev[si]! + (this.cur[ci]! - this.prev[si]!) * alpha;
      w[ci + 1] = this.baseY;
      // render.js interpolated z from prev[ci + 2] (not prev[si + 2]): a grown segment slides in along z — kept
      w[ci + 2] = this.prev[si + 2]! + (this.cur[ci + 2]! - this.prev[ci + 2]!) * alpha;
    }
    const count = (n - 1) * SUB + 1;
    const taperDenom = Math.max(1, count - 1);
    for (let s = 0; s < this.maxSamples; s++) {
      if (s >= count) {
        this.bodyMesh.setMatrixAt(s, this.zero);
        this.bellyMesh.setMatrixAt(s, this.zero);
        this.spikeMesh?.setMatrixAt(s, this.zero);
        continue;
      }
      const j = (s / SUB) | 0, t = (s - j * SUB) / SUB;
      const i0 = Math.max(0, j - 1) * 3, i1 = j * 3, i2 = Math.min(n - 1, j + 1) * 3, i3 = Math.min(n - 1, j + 2) * 3;
      const x = catmull(w[i0]!, w[i1]!, w[i2]!, w[i3]!, t);
      const z = catmull(w[i0 + 2]!, w[i1 + 2]!, w[i2 + 2]!, w[i3 + 2]!, t);
      const r = 1 - 0.45 * (s / taperDenom);
      this.s.set(r, r, r);
      this.m.compose(this.p.set(x, this.baseY, z), this.q, this.s);
      this.bodyMesh.setMatrixAt(s, this.m);
      this.m.compose(this.p.set(x, this.baseY - 0.09 * this.scale, z), this.q, this.s);
      this.bellyMesh.setMatrixAt(s, this.m);
      if (this.spikeMesh) {
        this.m.compose(this.p.set(x, this.baseY + 0.34 * this.scale * r, z), this.q, this.s);
        this.spikeMesh.setMatrixAt(s, this.m);
      }
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.bellyMesh.instanceMatrix.needsUpdate = true;
    if (this.spikeMesh) this.spikeMesh.instanceMatrix.needsUpdate = true;
    const hx = w[0]!, hz = w[2]!;
    let tx = hx, tz = hz;
    if (n > 1) {
      const i3 = Math.min(n - 1, 2) * 3;
      tx = catmull(w[0]!, w[0]!, w[3]!, w[i3]!, 0.5);
      tz = catmull(w[2]!, w[2]!, w[5]!, w[i3 + 2]!, 0.5);
    }
    const fx = hx - tx, fz = hz - tz;
    if (fx * fx + fz * fz > 1e-8) this.head.rotation.y = Math.atan2(fx, fz);
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
    this.headPos.x = hx; this.headPos.y = hy; this.headPos.z = hz;
  }
  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as Mesh; if (m.geometry) m.geometry.dispose(); });
    for (const m of this.mats) m.dispose();
  }
}

// ---------------------------------------------------------------- the arena
let world: Group | null = null;
let groundMesh: Mesh | null = null;
let particles: ParticlePool | null = null;
let pollen: PollenField | null = null;
let playerView: SerpentView | null = null;
const rivalViews = new Map<string, SerpentView>();
interface FoodView { group: Group; berry: Mesh; golden: Mesh; key: string; phase: number; pop: number; kind: string }
let foodViews: FoodView[] = [];
let goldenMat: MeshStandardMaterial | MeshLambertMaterial | null = null;
let goldenGlow = 1;
let previewRing: Mesh | null = null, previewGhost: Mesh | null = null;
let hintArrows: Record<Dir, Mesh> | null = null;
let hintDirs: Dir[] | null = null;
let config: RulesConfig | null = null;
let theme: Theme | null = null;
let gridW = 0, gridH = 0;
let lastState: State | null = null;
let snapshotStamp = 0;
const disposable: { dispose(): void }[] = [];

function cellToWorld(x: number, y: number, out: Float32Array, o: number): void {
  out[o] = (x - (gridW - 1) / 2) * CELL;
  out[o + 1] = 0;
  out[o + 2] = (y - (gridH - 1) / 2) * CELL;
}
function cellToWorldV(x: number, y: number, out: Vector3): Vector3 {
  return out.set((x - (gridW - 1) / 2) * CELL, 0, (y - (gridH - 1) / 2) * CELL);
}

function disposeWorld(): void {
  if (!world) return;
  playerView?.dispose();
  playerView = null;
  for (const v of rivalViews.values()) v.dispose();
  rivalViews.clear();
  world.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  for (const d of disposable.splice(0)) d.dispose();
  world.removeFromParent();
  world = null; groundMesh = null; particles = null; pollen = null; foodViews = []; goldenMat = null;
  previewRing = previewGhost = null; hintArrows = null; hintDirs = null;
}
function own<T extends { dispose(): void }>(x: T): T { disposable.push(x); return x; }

function buildGround(rng: () => number): void {
  const th = theme!;
  const geom = new PlaneGeometry(gridW * CELL, gridH * CELL, gridW, gridH);
  geom.rotateX(-Math.PI / 2);
  const pos = geom.getAttribute("position") as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const cA = new Color(th.ground), cB = new Color(th.groundDark), c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const cx = Math.floor(pos.getX(i) + gridW / 2), cy = Math.floor(pos.getZ(i) + gridH / 2);
    const checker = (((cx + cy) % 2) + 2) % 2;
    const f = Math.min(1, checker * 0.35 + rng() * 0.35);
    c.copy(cA).lerp(cB, f);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new BufferAttribute(colors, 3));
  const tex = look!.detailed ? detailTextures(look!.budget.texture) : null;
  const mat = own(surface({
    vertexColors: true, roughness: tex ? 0.94 : 1, metalness: 0, envMapIntensity: 0.06,
    map: tex ? own(repeated(tex.ground, gridW / 5, gridH / 5)) : null, bumpMap: tex ? own(repeated(tex.groundBump, gridW / 5, gridH / 5)) : null, bumpScale: 1.5,
  }));
  groundMesh = new Mesh(geom, mat);
  groundMesh.receiveShadow = true;
  world!.add(groundMesh);
  const apronSize = Math.max(gridW, gridH) * 3.2;
  const apron = new Mesh(new PlaneGeometry(apronSize, apronSize),
    own(surface({ color: th.groundDark, roughness: 1, envMapIntensity: 0.06, map: tex ? own(repeated(tex.ground, apronSize / 5, apronSize / 5)) : null })));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.03;
  apron.receiveShadow = true;
  world!.add(apron);
}

function buildGrass(count: number, rng: () => number, obstacles: Set<string>): void {
  const geom = new PlaneGeometry(0.07, 0.5, 1, 3);
  geom.translate(0, 0.25, 0);
  const p = geom.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * Math.max(0.08, 1 - p.getY(i) * 1.9));
  p.needsUpdate = true;
  const mat = own(surface({ color: 0xffffff, roughness: 0.9, side: DoubleSide, envMapIntensity: 0.08 }));
  (mat as MeshStandardMaterial).hooks = { uniforms: windU, vertex: WIND_VERT } as MaterialHooks;
  const mesh = new InstancedMesh(geom, mat, Math.max(1, count));
  mesh.frustumCulled = false;
  const m = new Matrix4(), q = new Quaternion(), eul = new Euler(), v = new Vector3(), s = new Vector3(), c = new Color();
  const pal = theme!.grass;
  let placed = 0, guard = count * 8;
  while (placed < count && guard-- > 0) {
    const gx = Math.floor(rng() * gridW), gy = Math.floor(rng() * gridH);
    if (obstacles.has(gx + "," + gy)) continue;
    const x = (gx - (gridW - 1) / 2 + (rng() - 0.5) * 0.94) * CELL;
    const z = (gy - (gridH - 1) / 2 + (rng() - 0.5) * 0.94) * CELL;
    eul.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.25);
    q.setFromEuler(eul);
    const sc = 0.7 + rng() * 0.7;
    m.compose(v.set(x, 0, z), q, s.set(sc, sc * (0.8 + rng() * 0.6), sc));
    mesh.setMatrixAt(placed, m);
    c.set(pal[(rng() * pal.length) | 0]!).multiplyScalar(0.85 + rng() * 0.3);
    mesh.setColorAt(placed, c);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  world!.add(mesh);
}

function buildFlowers(count: number, rng: () => number, obstacles: Set<string>): void {
  const stemGeom = new CylinderGeometry(0.02, 0.03, 0.34, 5);
  stemGeom.translate(0, 0.17, 0);
  const stems = new InstancedMesh(stemGeom, own(surface({ color: theme!.hedge, roughness: 0.9, envMapIntensity: 0.08 })), Math.max(1, count));
  const heads = new InstancedMesh(new IcosahedronGeometry(0.09, 0), own(surface({ color: 0xffffff, roughness: 0.6, envMapIntensity: 0.12 })), Math.max(1, count));
  stems.frustumCulled = heads.frustumCulled = false;
  const m = new Matrix4(), q = new Quaternion(), v = new Vector3(), s = new Vector3(1, 1, 1), c = new Color();
  const pal = theme!.flowers;
  let placed = 0, guard = count * 10;
  while (placed < count && guard-- > 0) {
    const gx = Math.floor(rng() * gridW), gy = Math.floor(rng() * gridH);
    if (obstacles.has(gx + "," + gy)) continue;
    const x = (gx - (gridW - 1) / 2 + (rng() - 0.5) * 0.9) * CELL;
    const z = (gy - (gridH - 1) / 2 + (rng() - 0.5) * 0.9) * CELL;
    const sc = 0.7 + rng() * 0.6;
    q.identity();
    m.compose(v.set(x, 0, z), q, s.set(sc, sc, sc));
    stems.setMatrixAt(placed, m);
    m.compose(v.set(x, 0.36 * sc, z), q, s.set(sc, sc, sc));
    heads.setMatrixAt(placed, m);
    c.set(pal[(rng() * pal.length) | 0]!);
    heads.setColorAt(placed, c);
    placed++;
  }
  stems.count = heads.count = placed;
  stems.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
  world!.add(stems, heads);
}

function hedgeMaterial(): Material {
  const tex = look!.detailed ? detailTextures(look!.budget.texture) : null;
  return own(surface({
    color: 0xffffff, roughness: 0.95, envMapIntensity: 0.08,
    map: tex ? own(repeated(tex.leaf, 2, 1)) : null, bumpMap: tex ? own(repeated(tex.leafBump, 2, 1)) : null, bumpScale: 3,
  }));
}

function buildHedgeWall(rng: () => number): void {
  const perim = 2 * (gridW + 1) + 2 * (gridH + 1);
  const mesh = new InstancedMesh(new BoxGeometry(1.02, 0.55, 0.4), hedgeMaterial(), perim);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const m = new Matrix4(), q = new Quaternion(), eul = new Euler(), v = new Vector3(), s = new Vector3(), c = new Color();
  const base = new Color(theme!.hedge);
  const halfW = gridW / 2, halfH = gridH / 2;
  let i = 0;
  const put = (x: number, z: number, rotY: number): void => {
    eul.set(0, rotY, 0);
    q.setFromEuler(eul);
    m.compose(v.set(x, 0.24 + rng() * 0.08, z), q, s.set(1, 0.9 + rng() * 0.35, 1));
    mesh.setMatrixAt(i, m);
    c.copy(base).multiplyScalar(0.85 + rng() * 0.3);
    mesh.setColorAt(i, c);
    i++;
  };
  for (let x = 0; x < gridW + 1; x++) { put(x - halfW, -halfH - 0.35, 0); put(x - halfW, halfH - 0.5 + 0.85, 0); }
  for (let y = 0; y < gridH + 1; y++) { put(-halfW - 0.35, y - halfH, Math.PI / 2); put(halfW - 0.5 + 0.85, y - halfH, Math.PI / 2); }
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  world!.add(mesh);
}

function buildObstacles(cells: Cell[]): void {
  if (!cells.length) return;
  const seed = config!.seed >>> 0;
  const rocks: { cell: Cell; h: number }[][] = [[], [], []];
  const hedges: { cell: Cell; h: number }[] = [];
  for (const cell of cells) {
    const h = hashCell(cell.x, cell.y, seed);
    if (h % 5 < 3) rocks[h % 3]!.push({ cell, h });
    else hedges.push({ cell, h });
  }
  const m = new Matrix4(), q = new Quaternion(), eul = new Euler(), v = new Vector3(), s = new Vector3(), c = new Color();
  const blobGeom = new CircleGeometry(0.46, 18);
  blobGeom.rotateX(-Math.PI / 2);
  const blobs = new InstancedMesh(blobGeom, own(new MeshBasicMaterial({ color: 0x081008, transparent: true, opacity: 0.3, depthWrite: false })), cells.length);
  let blobCount = 0;
  const rockBase = new Color(theme!.rock);
  [0, 1, 2].forEach((variant) => {
    const list = rocks[variant]!;
    if (!list.length) return;
    // Rock variants: icosahedra with deterministic radial deformation (flat shaded: non-indexed).
    const g = new IcosahedronGeometry(0.42, 1);
    const r = mulberry32((config!.seed ^ (0x50c + variant * 7919)) >>> 0);
    const p = g.getAttribute("position") as BufferAttribute;
    const pv = new Vector3();
    for (let i = 0; i < p.count; i++) {
      pv.fromBufferAttribute(p, i);
      const k = 0.78 + r() * 0.5;
      p.setXYZ(i, pv.x * k, pv.y * k * 0.72, pv.z * k);
    }
    g.computeVertexNormals();
    const mesh = new InstancedMesh(g, own(surface({ color: 0xffffff, roughness: 0.82, flatShading: true, envMapIntensity: 0.12 })), list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach(({ cell, h }, i) => {
      const rr = mulberry32(h);
      eul.set(0, rr() * Math.PI * 2, 0);
      q.setFromEuler(eul);
      const sc = 0.8 + rr() * 0.45;
      cellToWorldV(cell.x, cell.y, v); v.y = 0.1;
      m.compose(v, q, s.set(sc, sc, sc));
      mesh.setMatrixAt(i, m);
      c.copy(rockBase).multiplyScalar(0.85 + rr() * 0.3);
      mesh.setColorAt(i, c);
      m.compose(v.set(v.x, 0.012, v.z), q.identity(), s.set(sc, 1, sc));
      blobs.setMatrixAt(blobCount++, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    world!.add(mesh);
  });
  if (hedges.length) {
    const mesh = new InstancedMesh(new BoxGeometry(0.88, 0.6, 0.88), hedgeMaterial(), hedges.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const hedgeBase = new Color(theme!.hedge);
    hedges.forEach(({ cell, h }, i) => {
      const rr = mulberry32(h);
      eul.set(0, (rr() - 0.5) * 0.5, 0);
      q.setFromEuler(eul);
      const sc = 0.9 + rr() * 0.25;
      cellToWorldV(cell.x, cell.y, v); v.y = 0.28;
      m.compose(v, q, s.set(sc, sc * (0.9 + rr() * 0.3), sc));
      mesh.setMatrixAt(i, m);
      c.copy(hedgeBase).multiplyScalar(0.85 + rr() * 0.3);
      mesh.setColorAt(i, c);
      m.compose(v.set(v.x, 0.012, v.z), q.identity(), s.set(sc, 1, sc));
      blobs.setMatrixAt(blobCount++, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    world!.add(mesh);
  }
  blobs.count = blobCount;
  blobs.instanceMatrix.needsUpdate = true;
  world!.add(blobs);
}

function buildFoodPool(): void {
  const m1 = new Matrix4();
  const berry = mergeParts([
    { geom: new SphereGeometry(0.15, 10, 8), matrix: m1.clone().makeTranslation(-0.09, 0.13, 0.02), color: 0xffffff },
    { geom: new SphereGeometry(0.15, 10, 8), matrix: m1.clone().makeTranslation(0.09, 0.13, -0.02), color: 0xf2f2f2 },
    { geom: new SphereGeometry(0.16, 10, 8), matrix: m1.clone().makeTranslation(0, 0.2, 0.06), color: 0xffffff },
    { geom: new ConeGeometry(0.05, 0.12, 5), matrix: m1.clone().makeTranslation(0, 0.36, 0.06), color: 0x3f7a33 },
  ]);
  const spikes = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    spikes.push({ geom: new ConeGeometry(0.05, 0.2, 4) as BufferGeometry, matrix: new Matrix4().makeTranslation(Math.cos(a) * 0.14, 0.42, Math.sin(a) * 0.14), color: 0xfff2c0 });
  }
  const golden = mergeParts([
    { geom: new SphereGeometry(0.2, 12, 10), matrix: new Matrix4().makeTranslation(0, 0.22, 0), color: 0xffffff },
    { geom: new TorusGeometry(0.15, 0.035, 6, 12), matrix: new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.34, 0), color: 0xffe9a0 },
    ...spikes,
  ]);
  const detailed = look!.detailed;
  const gloss = detailed ? { clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.35 } : { envMapIntensity: 0.25 };
  const berryMat = own(surface({ vertexColors: true, roughness: detailed ? 0.32 : 0.45, color: adjustForPalette(theme!.food, "food", palette), ...gloss }, detailed));
  const gold = adjustForPalette(theme!.foodGolden, "foodGolden", palette);
  goldenMat = own(surface({ vertexColors: true, roughness: detailed ? 0.2 : 0.3, metalness: detailed ? 0.35 : 0, color: gold, emissive: gold, emissiveIntensity: 0.55, ...gloss }, detailed)) as MeshStandardMaterial;
  goldenGlow = detailed ? 1.6 : 1;
  foodViews = [];
  for (let i = 0; i < MAX_FOOD_VIEWS; i++) {
    const group = new Group();
    const b = new Mesh(berry, berryMat), g = new Mesh(golden, goldenMat);
    b.castShadow = g.castShadow = true;
    group.add(b, g);
    group.visible = false;
    world!.add(group);
    foodViews.push({ group, berry: b, golden: g, key: "", phase: 0, pop: 0, kind: "berry" });
  }
}

function buildMarkers(): void {
  const ringGeom = new RingGeometry(0.3, 0.42, 28);
  ringGeom.rotateX(-Math.PI / 2);
  previewRing = new Mesh(ringGeom, own(new MeshBasicMaterial({ color: 0xfffbe0, transparent: true, opacity: 0.85, depthWrite: false })));
  previewRing.position.y = 0.02;
  const ghostGeom = new PlaneGeometry(0.86, 0.86);
  ghostGeom.rotateX(-Math.PI / 2);
  previewGhost = new Mesh(ghostGeom, own(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false })));
  previewGhost.position.y = 0.08;
  previewRing.visible = previewGhost.visible = false;
  world!.add(previewRing, previewGhost);
  const arrowGeom = new ConeGeometry(0.16, 0.3, 3);
  arrowGeom.rotateX(Math.PI / 2);
  arrowGeom.scale(1, 0.35, 1);
  const dirs: Record<Dir, number> = { up: Math.PI, right: Math.PI / 2, down: 0, left: -Math.PI / 2 };
  const arrows = {} as Record<Dir, Mesh>;
  for (const [name, rotY] of Object.entries(dirs) as [Dir, number][]) {
    // render.js rotated "up" by 0 (pointing +Z, down the screen) and "down" by π: the arrows pointed back at the head.
    // They point away from it here, toward the safe cell.
    const mesh = new Mesh(arrowGeom, own(new MeshBasicMaterial({ color: 0xfffbe0, transparent: true, opacity: 0.55, depthWrite: false })));
    mesh.rotation.y = rotY;
    mesh.visible = false;
    world!.add(mesh);
    arrows[name] = mesh;
  }
  hintArrows = arrows;
}

function applyThemeToLights(): void {
  const th = theme!;
  scene.background = new Color(th.sky);
  scene.fog = new Fog(th.fog, cameraDistance() * 1.3, cameraDistance() * 3.4);
  keyLight.color.set(th.sun);
  keyLight.intensity = th.sunIntensity;
  hemiLight.color.set(th.sky);
  hemiLight.groundColor.set(th.groundDark);
  // Image-based lighting adds its own soft fill, so the hemisphere eases off.
  hemiLight.intensity = envMap() ? 0.65 : 0.75;
  const m = Math.max(gridW, gridH);
  keyLight.position.set(m * 0.7, m * 1.15, m * 0.45);
  keyLight.target.position.set(0, 0, 0);
  fitShadow();
}
/** render.js positionLights: the shadow frustum fitted tightly around the arena + hedge wall, in light space. */
function fitShadow(): void {
  const eye = keyLight.position;
  const zAxis = new Vector3().copy(eye).sub(keyLight.target.position).normalize();
  const xAxis = new Vector3(0, 1, 0).cross(zAxis).normalize();
  const yAxis = new Vector3().copy(zAxis).cross(xAxis);
  const hx = gridW / 2 + 1, hz = gridH / 2 + 1;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const cx of [-hx, hx]) for (const cy of [0, 1.4]) for (const cz of [-hz, hz]) {
    const d = new Vector3(cx, cy, cz).sub(eye);
    const x = d.dot(xAxis), y = d.dot(yAxis), z = d.dot(zAxis);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const cam = keyLight.shadow.camera as OrthographicCamera;
  cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1;
  cam.near = Math.max(0.1, -z1 - 1); cam.far = -z0 + 1;
  cam.updateProjectionMatrix();
}

let aspect = 1;
function cameraDistance(): number {
  const half = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  const fitV = (Math.max(gridW, gridH) * 0.55 + 1.6) / half;
  const fitH = (gridW * 0.55 + 1.6) / (half * aspect);
  return Math.max(fitV, fitH);
}
function cameraBaseTarget(out: Vector3): Vector3 {
  const dist = cameraDistance();
  if (cameraView === "top") return out.set(0, dist * 1.5, 0.001);
  return out.set(0, dist * Math.sin(CAMERA_ELEVATION), dist * Math.cos(CAMERA_ELEVATION));
}

/** Critically damped spring (explicit velocity state). */
class Spring3 {
  p = new Vector3(); v = new Vector3(); t = new Vector3();
  snap(x: number, y: number, z: number): void { this.p.set(x, y, z); this.t.set(x, y, z); this.v.set(0, 0, 0); }
  update(dt: number, omega: number): void {
    const k = omega * omega, d = 2 * omega;
    this.v.x += (k * (this.t.x - this.p.x) - d * this.v.x) * dt;
    this.v.y += (k * (this.t.y - this.p.y) - d * this.v.y) * dt;
    this.v.z += (k * (this.t.z - this.p.z) - d * this.v.z) * dt;
    this.p.set(this.p.x + this.v.x * dt, this.p.y + this.v.y * dt, this.p.z + this.v.z * dt);
  }
}
const camSpring = new Spring3();
const lookSpring = new Spring3();
let trauma = 0;
let simTime = 0;
let paused = false;
const _v3 = new Vector3();

function buildScene(): void {
  disposeWorld();
  gridW = config!.grid.w;
  gridH = config!.grid.h;
  world = new Group();
  scene.add(world);
  const rng = mulberry32((config!.seed ^ 0xdec0) >>> 0);
  const obstacles = config!.obstacles || [];
  const obstacleSet = new Set(obstacles.map((c) => c.x + "," + c.y));
  buildGround(rng);
  buildGrass(grassCount(look!), rng, obstacleSet);
  buildFlowers(flowerCount(look!), rng, obstacleSet);
  buildHedgeWall(rng);
  buildObstacles(obstacles);
  buildFoodPool();
  buildMarkers();
  particles = new ParticlePool(world, look!.budget.particles, look!.detailed);
  own(particles.material);
  pollen = look!.particles === "high" ? new PollenField(world, gridW, gridH, theme!.foodGolden, look!.budget.pollen) : null;
  if (pollen) own(pollen.material);
  keyLight.castShadow = look!.shadows > 0;
  applyThemeToLights();
  cameraBaseTarget(_v3);
  camSpring.snap(_v3.x, _v3.y, _v3.z);
  lookSpring.snap(0, 0, 0);
  trauma = 0;
  lastState = null;
}

// ---------------------------------------------------------------- the public API (render.js api)
/** loadArena(config, theme): builds the arena for a round (or the title's attract garden). */
export function loadArena(cfg: RulesConfig, th: Theme): void {
  config = cfg;
  theme = th;
  if (look) buildScene();
}

/** syncSnapshot(state, alpha): the serpents, rivals and food of an immutable rules snapshot, interpolated by alpha. */
export function syncSnapshot(state: State | null, alpha: number, dt: number): void {
  if (!world || !state || !theme) return;
  const a = Math.min(1, Math.max(0, alpha));
  lastState = state;
  const L = look!;
  if (!playerView) {
    playerView = new SerpentView(world, {
      scale: 1, spiky: false, maxJoints: MAX_JOINTS, detail: L.detailed, texture: L.budget.texture, body: L.budget.body,
      headColor: theme.snakeHead, bodyColor: theme.snakeBody, bellyColor: theme.snakeBelly,
    });
  }
  playerView.setBody(state.snake.body, state.tick);
  playerView.update(a, dt);
  snapshotStamp++;
  for (const r of state.rivals) {
    let view = rivalViews.get(r.id);
    if (!view) {
      const big = r.tier === "big";
      const col = adjustForPalette(big ? theme.rivalBig : theme.rivalSmall, big ? "rivalBig" : "rivalSmall", palette);
      view = new SerpentView(world, {
        scale: big ? 1.3 : 0.72, spiky: big, maxJoints: RIVAL_MAX_JOINTS, detail: L.detailed, texture: L.budget.texture,
        body: Math.max(8, Math.round(L.budget.body * 0.75)), headColor: col, bodyColor: col, bellyColor: theme.snakeBelly,
      });
      rivalViews.set(r.id, view);
    }
    view.stamp = snapshotStamp;
    if (!r.alive || !r.body.length) { view.group.visible = false; continue; }
    view.setBody(r.body, state.tick);
    view.update(a, dt);
  }
  for (const [id, view] of rivalViews) if (view.stamp !== snapshotStamp) { view.dispose(); rivalViews.delete(id); }
  for (let i = 0; i < foodViews.length; i++) {
    const fv = foodViews[i]!, f = state.food[i];
    if (!f) { fv.group.visible = false; fv.key = ""; continue; }
    const key = `${f.x},${f.y},${f.kind}`;
    if (fv.key !== key) {
      fv.key = key;
      fv.kind = f.kind;
      fv.berry.visible = f.kind === "berry";
      fv.golden.visible = f.kind === "golden";
      cellToWorldV(f.x, f.y, fv.group.position);
      fv.phase = (hashCell(f.x, f.y, 0xfeed) % 628) / 100;
      fv.pop = 1;
    }
    fv.group.visible = true;
  }
  if (hintArrows && hintDirs) {
    const hp = playerView.headPos, off = 0.48;
    hintArrows.up.position.set(hp.x, 0.05, hp.z - off);
    hintArrows.down.position.set(hp.x, 0.05, hp.z + off);
    hintArrows.left.position.set(hp.x - off, 0.05, hp.z);
    hintArrows.right.position.set(hp.x + off, 0.05, hp.z);
  }
}

/** playEvent(event): bursts, tilts, wobbles, pulses and shake per game event. */
export function playEvent(e: GameEvent): void {
  if (!world || !theme || !look) return;
  const countScale = PARTICLE_SCALE[look.particles] * (reducedMotion ? 0.5 : 1);
  const cellV = (c: Cell): Vector3 => cellToWorldV(c.x, c.y, _v3);
  const hp = playerView?.headPos;
  switch (e.type) {
    case "turn": playerView?.kickTilt(e.dir === "left" || e.dir === "down" ? 0.16 : -0.16); break;
    case "eat": if (e.cell) { const p = cellV(e.cell); particles?.burst(p.x, 0.2, p.z, e.kind === "golden" ? theme.foodGolden : theme.food, 0, countScale); } break;
    case "grow": if (hp) particles?.burst(hp.x, 0.2, hp.z, theme.grass[2] ?? theme.grass[0]!, 1, countScale); break;
    case "rival-defeated": if (e.cell) { const p = cellV(e.cell); particles?.burst(p.x, 0.25, p.z, theme.rivalSmall, 1, countScale); } break;
    case "death":
      if (e.cell) { const p = cellV(e.cell); particles?.burst(p.x, 0.3, p.z, theme.food, 2, countScale); }
      if (!reducedMotion) trauma = Math.min(1, trauma + 0.75);
      break;
    case "win":
      if (e.cell) { const p = cellV(e.cell); particles?.burst(p.x, 0.3, p.z, theme.foodGolden, 2, countScale); }
      if (!reducedMotion) { trauma = Math.min(1, trauma + 0.35); camSpring.v.y += 1.2; }
      break;
    case "invalid": playerView?.kickWobble(); break;
    case "undo": if (hp) particles?.burst(hp.x, 0.2, hp.z, theme.water, 0, countScale * 0.6); break;
    case "countdown": playerView?.kickPulse(0.7); break;
    case "go":
      playerView?.kickPulse(1);
      if (hp) particles?.burst(hp.x, 0.2, hp.z, 0xffffff, 0, countScale);
      break;
  }
}

export function previewCell(cell: Cell | null): void {
  if (!previewRing || !previewGhost) return;
  if (!cell) { previewRing.visible = previewGhost.visible = false; return; }
  cellToWorldV(cell.x, cell.y, _v3);
  previewRing.position.set(_v3.x, 0.02, _v3.z);
  previewGhost.position.set(_v3.x, 0.08, _v3.z);
  previewRing.visible = previewGhost.visible = true;
}
export function showHint(dirs: Dir[] | null): void {
  if (!hintArrows) return;
  hintDirs = dirs;
  for (const [name, mesh] of Object.entries(hintArrows) as [Dir, Mesh][]) mesh.visible = !!dirs && dirs.includes(name);
}

/** pickCell: window pixels → the arena cell under them (ground raycast, the shake zeroed). */
export function pickCell(x: number, y: number): Cell | null {
  if (!groundMesh || !renderer.camera) return null;
  const sp = shakeGroup.position.clone(), rz = shakeGroup.rotation.z;
  shakeGroup.position.set(0, 0, 0);
  shakeGroup.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const hit = raycaster.intersectObject(groundMesh, false)[0];
  shakeGroup.position.copy(sp);
  shakeGroup.rotation.z = rz;
  camera.updateMatrixWorld(true);
  if (!hit) return null;
  const cx = Math.floor(hit.point.x / CELL + gridW / 2), cy = Math.floor(hit.point.z / CELL + gridH / 2);
  if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return null;
  return { x: cx, y: cy };
}
/** A cell's footprint in window pixels (for the named targets of the accessibility mirror). */
export function cellRect(cell: Cell): Rect | null {
  if (!world) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  cellToWorldV(cell.x, cell.y, _v3);
  const cx = _v3.x, cz = _v3.z;
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
    const v = new Vector3(cx + dx, 0, cz + dz).project(camera);
    const sx = view.x + ((v.x + 1) / 2) * view.w, sy = view.y + ((1 - v.y) / 2) * view.h;
    x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------- the look and options
let builtKey = "";
/** setGraphics: the runtime's quality tier applied live (no reload). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = next.shadows > 0;
  keyLight.castShadow = next.shadows > 0;
  if (next.shadows > 0) keyLight.shadow.mapSize = next.shadows;
  // GTAOPass: radius 0.45, distance exponent 1.5, thickness 1, blend 0.8 / 0.65, 16 / 8 samples and the denoise per tier.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.8 : 0.65, radius: 0.45, distanceExponent: 1.5, thickness: 1, scale: 1,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // UnrealBloomPass(0.35, 0.35, 0.92): only golden food, particles and bright glints bloom.
  // r160 page: the engine's r160 bloom model at the page's strength (engine.minor 30).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.35, radius: 0.35, threshold: 0.92, resolution: next.budget.bloomRes } : null;
  // GradeShader in linear light before the OutputPass: an 0.18 smoothstep S-curve (contrastCurve "s"), saturation 1.1, cool shadows / warm highlights
  // by a smoothstep of luma from 0.15 to 0.8, a 0.2 vignette from 0.38 to 0.85 (y scaled 0.85).
  renderer.grade = next.grade ? {
    space: "linear", contrastCurve: "s", overRange: "keep", contrast: 0.18, saturation: 1.1, split: [0.15, 0.8], shadows: [0.97, 0.99, 1.04], highlights: [1.04, 1.01, 0.95],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.85, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
  const k = `${next.detailed}|${next.reflections}|${next.particles}|${next.foliage}|${JSON.stringify(next.budget)}`;
  if (k !== builtKey) {
    builtKey = k;
    if (config && theme) {
      const keep = lastState;
      buildScene();
      if (keep) syncSnapshot(keep, 1, 0);
    }
  }
}
/** The colour-vision palette (rival and food hues): rebuilds the arena's colours. */
export function setPalette(p: string): void {
  if (p === palette) return;
  palette = p;
  if (config && theme && look) {
    const keep = lastState;
    buildScene();
    if (keep) syncSnapshot(keep, 1, 0);
  }
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
export function setCameraView(v: string): void { cameraView = v === "top" ? "top" : "default"; }
/** The decorative clock freezes while paused (render.js setPaused). */
export function setPaused(on: boolean): void { paused = on; }
/** Whether the arena draws. */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }
setActive(true);

// ---------------------------------------------------------------- the frame
const view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
let viewKey = "";
let appliedUp = "";
/** Each frame: the camera into the playfield rectangle (window px), springs, decor, particles, shake. */
export function update(dt: number, W: number, H: number, rect: Rect): void {
  dt = Math.min(0.05, dt);
  const k = `${W}x${H}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  if (W > 0 && H > 0 && rect.width > 0 && rect.height > 0 && k !== viewKey) {
    viewKey = k;
    Object.assign(view, { x: rect.x, y: rect.y, w: rect.width, h: rect.height, W, H });
    aspect = rect.width / rect.height;
    camera.aspect = aspect;
    camera.setViewOffset(rect.width, rect.height, -rect.x, -rect.y, W, H);
    camera.updateProjectionMatrix();
    if (theme) applyThemeToLights();
    // Attenuated points size by the drawing height: the old canvas was the playfield, the window is taller.
  }
  const ptScale = view.h / Math.max(1, view.H);
  if (particles) particles.material.size = (look?.detailed ? 0.22 : 0.14) * ptScale;
  if (pollen) pollen.material.size = 0.09 * ptScale;
  if (!paused) simTime += dt;
  if (!world) return;
  // Camera: the base framing, a gentle weighted follow of the interpolated head.
  const up = cameraView === "top" ? "top" : "default";
  if (up !== appliedUp) { appliedUp = up; camera.up.set(0, up === "top" ? 0 : 1, up === "top" ? -1 : 0); }
  cameraBaseTarget(camSpring.t);
  let lx = 0, lz = 0;
  if (playerView && lastState && lastState.snake.alive) {
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
  trauma = Math.max(0, trauma - dt * 1.1);
  if (trauma > 0 && !reducedMotion) {
    const s = trauma * trauma, t = simTime * 31;
    shakeGroup.position.set(Math.sin(t * 1.1) * 0.16 * s, Math.sin(t * 1.7 + 2) * 0.12 * s, 0);
    shakeGroup.rotation.z = Math.sin(t * 1.3 + 4) * 0.015 * s;
  } else {
    shakeGroup.position.set(0, 0, 0);
    shakeGroup.rotation.set(0, 0, 0);
  }
  if (paused) return;
  // Decor: wind, food bob and golden shimmer, the preview ring's pulse, the hint arrows, particles, pollen.
  windU.uTime.value = simTime;
  windU.uAmp.value = 0.12 * (reducedMotion ? 0.05 : 1);
  const bobAmp = reducedMotion ? 0.018 : 0.06;
  for (const fv of foodViews) {
    if (!fv.group.visible) continue;
    fv.pop = Math.max(0, fv.pop - dt * 2.2);
    fv.group.position.y = Math.sin(simTime * 2.2 + fv.phase) * bobAmp;
    const sc = 1 + fv.pop * 0.55 + (fv.kind === "golden" ? Math.sin(simTime * 3 + fv.phase) * 0.05 : 0);
    fv.group.scale.set(sc, sc, sc);
    if (fv.kind === "golden" && goldenMat) goldenMat.emissiveIntensity = (0.5 + Math.sin(simTime * 3.1 + fv.phase) * 0.2) * goldenGlow;
  }
  if (previewRing?.visible) { const p = 1 + Math.sin(simTime * 5) * 0.07; previewRing.scale.set(p, 1, p); }
  if (hintArrows && hintDirs) {
    const pulse = 0.45 + Math.sin(simTime * 4) * 0.15;
    for (const d of hintDirs) (hintArrows[d].material as MeshBasicMaterial).opacity = pulse;
  }
  particles?.update(dt);
  if (pollen) {
    pollen.points.visible = !reducedMotion;
    if (!reducedMotion) pollen.update(simTime);
  }
}
