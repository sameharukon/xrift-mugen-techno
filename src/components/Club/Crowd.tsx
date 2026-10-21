import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, LatheGeometry, Object3D, ShaderMaterial, SphereGeometry, Vector2 } from 'three'
import { beat } from '../../techno/beat'
import { meter } from './index'
import { SHADER_PERIOD, shaderClock } from './fx'

// ---------------------------------------------------------------- mist material
/**
 * "人間の輪郭がぼんやりあるもや": additive, depthWrite off (no sorting issues across instances),
 * fresnel rim → soft glowing edges with a see-through core, time-scrolled 3D value-noise fbm → wispy drift.
 * Two layers on body + head (core + inflated faint halo) blur the outline; per-figure phase / speed / scale. Colour follows the rig:
 * pale cold white rim + white hits from behind, deep red from the floor pulse below. 0 when lit = 0.
 */
const MIST_VERT = /* glsl */ `
uniform float uInflate;
uniform float uTime;
uniform float uFade;
uniform float uPeriod;
uniform float uWaver;
/** 0 = body (lathe, local y = 0 feet … 1.53 neck), 1 = head (sphere around the head centre) */
uniform float uPart;
/** per figure: x = noise phase offset, y = drift speed ×, z = noise scale ×, w = waver amplitude × */
attribute vec4 aMist;
/** per figure (static): x = shoulder width ×, y = hip width ×, z = depth ×, w = head size × */
attribute vec4 aBuild;
/** per figure (static): x = leg length ×, y = torso length ×, z = slouch (0 … 1), w = motion seed */
attribute vec4 aShape;
/** per figure (per frame, CPU): x = dance intensity, y = weight shift (−1 … 1) */
attribute vec4 aDyn;
varying vec3 vN;
varying vec3 vWP;
varying float vH;
/** v17b: undeformed local position (smoke field sticks to the figure) */
varying vec3 vL;
/** v17b: x = smoke seed, y = smoke scale ×, z = density ×, w = part (0 body, 1 head) */
varying vec4 vS;
float vhash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoiseV(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vhash(i), vhash(i + vec3(1, 0, 0)), f.x), mix(vhash(i + vec3(0, 1, 0)), vhash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(vhash(i + vec3(0, 0, 1)), vhash(i + vec3(1, 0, 1)), f.x), mix(vhash(i + vec3(0, 1, 1)), vhash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
/** x: fine wavering, y: slow sway, z: depth drift — for one (wrapped) time value */
vec3 waver(vec3 wp, vec3 seed, float tm) {
  vec3 q = wp * vec3(2.6, 1.6, 2.6) * aMist.z + seed + vec3(0.0, -tm * 0.55, tm * 0.08);
  return vec3(vnoiseV(q) * 0.65 + vnoiseV(q * 2.1 + 4.3) * 0.35, vnoiseV(q * 0.7 + vec3(9.1, -tm * 0.25, 2.7)), vnoiseV(q * 0.6 + 13.7));
}
// ---- organic body motion: smooth 1D value noise (quintic), never periodic within a wrap period ----
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float n1(float t) { float i = floor(t), f = t - i; float u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); return mix(h11(i), h11(i + 1.0), u) * 2.0 - 1.0; }
float fbm1(float t) { return 0.7 * n1(t) + 0.3 * n1(t * 2.13 + 17.1); }
/** local-space offsets (m) for one time value: xyz = hips (x/z), torso top (x/z), head (x, y, z) packed in 3 vec3 */
void bodyNoise(float t, float sd, float I, out vec3 hip, out vec3 torso, out vec3 hd) {
  float e = 0.35 + 0.65 * clamp(I, 0.0, 1.3); // more alive while dancing harder
  float fh = 0.12 + 0.16 * h11(sd * 3.1), ft = 0.17 + 0.25 * h11(sd * 5.7), fd = 0.22 + 0.35 * h11(sd * 7.9);
  hip = vec3(fbm1(t * fh + sd * 11.0), 0.0, fbm1(t * fh + sd * 23.0 + 40.0)) * vec3(0.022, 0.0, 0.014) * e;
  torso = vec3(fbm1(t * ft + sd * 31.0 + 80.0), 0.0, fbm1(t * ft + sd * 37.0 + 120.0)) * vec3(0.035, 0.0, 0.03) * e;
  hd = vec3(fbm1(t * fd + sd * 41.0 + 160.0), fbm1(t * fd * 1.3 + sd * 43.0 + 200.0), fbm1(t * fd + sd * 47.0 + 240.0)) * vec3(0.018, 0.008, 0.016) * e;
}
void main() {
  // ---- per-figure build (static) + organic motion, in the figure's own frame (before the instance matrix) ----
  vec3 hip, torso, hd;
  float sd = aShape.w;
  bodyNoise(uTime, sd, aDyn.x, hip, torso, hd);
  if (uFade > 0.0) { // wrapped time: crossfade into the next period's start (seamless at the 1000 s wrap)
    vec3 h2, t2, d2;
    bodyNoise(uTime - uPeriod, sd, aDyn.x, h2, t2, d2);
    hip = mix(hip, h2, uFade); torso = mix(torso, t2, uFade); hd = mix(hd, d2, uFade);
  }
  vec3 p = position;
  float ws = aDyn.y;
  if (uPart < 0.5) {
    float y = p.y;
    // hips → shoulders width, chest / belly depth
    p.x *= mix(aBuild.y, aBuild.x, smoothstep(0.7, 1.3, y));
    p.z *= aBuild.z;
    // leg / torso proportion
    p.y = y < 0.8 ? y * aShape.x : 0.8 * aShape.x + (y - 0.8) * aShape.y;
    // slouch: upper back rounds forward, shoulders drop a little
    float up = smoothstep(0.85, 1.53, y);
    p.z += aShape.z * up * up * 0.07;
    p.y -= aShape.z * up * 0.025;
    // motion: hips sway (feet planted), torso moves on top of it; weight shift → upper body counter-balances
    float wH = smoothstep(0.15, 0.95, y), wT = pow(smoothstep(0.8, 1.53, y), 1.5);
    p += hip * wH + torso * wT;
    p.x -= ws * 0.018 * wT;
  } else {
    p *= aBuild.w;
    // the head rides on the torso and adds its own small bob / sway
    p += hip + torso + hd;
    p.x -= ws * 0.018;
  }
  mat4 m = modelMatrix * instanceMatrix;
  // v17b: analytic smooth normals (radial for the lathe body, elliptic section) → no lathe seam / facet stripes
  vec3 rad = normalize(vec3(position.x, 0.0, position.z / 0.4624) + 1e-5);
  vec3 nl = uPart < 0.5 ? normalize(rad * length(normal.xz) + vec3(0.0, normal.y, 0.0)) : normalize(position * vec3(1.0, 0.8, 1.0));
  vec3 n = normalize(mat3(m) * nl);
  vec4 wp = m * vec4(p, 1.0);
  // ---- wavering outline (smoke / heat haze): noise displacement mostly along the normal ----
  // per-instance phase from the instance position; field scrolls upward (rising flow)
  vec3 seed = vec3(instanceMatrix[3].x * 1.7, 0.0, instanceMatrix[3].z * 1.3) + aMist.x * vec3(7.3, 3.1, 5.9);
  float up = clamp(wp.y / 1.75, 0.0, 1.0);
  // wrapped time (float32-safe); crossfade into the next period's start near the wrap (uFade)
  vec3 W = waver(wp.xyz, seed, uTime * aMist.y);
  if (uFade > 0.0) W = mix(W, waver(wp.xyz, seed, (uTime - uPeriod) * aMist.y), uFade);
  float d = W.x, d2 = W.y, d3 = W.z;
  // stronger at the silhouette (normal ⟂ view) and towards the upper body; feet stay planted
  vec3 toCam = normalize(cameraPosition - wp.xyz);
  float edge = 1.0 - abs(dot(n, toCam));
  float wv = uWaver * aMist.w;
  float amp = wv * (0.35 + 0.65 * edge) * (0.25 + 0.75 * up);
  wp.xyz += n * ((d - 0.45) * 0.07 * amp + uInflate);
  // whole figure drifts a few cm like smoke, more at the top
  wp.x += (d2 - 0.5) * 0.05 * up * wv;
  wp.z += (d3 - 0.5) * 0.04 * up * wv;
  // wisps trail upward at the edges of the upper body
  wp.y += smoothstep(0.55, 0.95, d) * 0.07 * edge * up * up * wv;
  vN = n;
  vWP = wp.xyz;
  vH = wp.y;
  vL = position;
  vS = vec4(aMist.x * 37.0 + sd, aMist.z, 0.7 + 0.6 * h11(sd * 13.3), uPart);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const MIST_FRAG = /* glsl */ `
uniform float uTime;
uniform float uFade;
uniform float uPeriod;
uniform float uLit;
uniform float uWhite;
uniform float uRed;
uniform float uBase;
uniform float uLayer;
uniform vec3 uCold;
uniform vec3 uRedCol;
varying vec3 vN;
varying vec3 vWP;
varying float vH;
varying vec3 vL;
varying vec4 vS;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
/** v17b smoke: domain-warped fbm in figure-local space, rising slowly. x = fine smoke, y = coarse density patches */
vec2 smoke(vec3 q, float t) {
  float wa = vnoise(q * 0.7 + vec3(0.0, -t * 0.16, 0.0)), wb = vnoise(q * 0.7 + vec3(5.2, 1.3 - t * 0.13, 2.9));
  vec3 w = vec3(wa - 0.5, wb - 0.5, wa - wb); // 2-noise warp (cheaper than 3)
  vec3 r = q + w * 1.9 + vec3(0.0, -t * 0.32, 0.0);
  float f = 0.62 * vnoise(r) + 0.38 * vnoise(r * 2.17 + vec3(3.1, -t * 0.2, 1.7)); // 4 noise taps total (same as v17)
  return vec2(f, 0.5 + 0.5 * (wa - wb) + 0.25 * (wa + wb - 1.0)); // coarse density patches from the warp field
}
void main() {
  if (uLit < 0.002) discard;
  vec3 V = normalize(cameraPosition - vWP);
  float fres = 1.0 - abs(dot(normalize(vN), V));
  // thickness through the volume only — no rim band (→ no head rings / outline)
  float thick = 1.0 - smoothstep(0.0, 0.92, fres);
  thick *= thick;
  // vertical envelope first (cheap) → skip the smoke noise where nothing would show (feet, grazing silhouette)
  float env = thick * smoothstep(0.35, 1.2, vH);
  if (vS.w > 0.5) env *= 0.85 * (1.0 - 0.9 * smoothstep(-0.04, 0.13, vL.y));
  else env *= 1.0 - 0.85 * smoothstep(1.18, 1.5, vL.y); // shoulders melt away (no ledge); head halo carries the top
  if (env < 0.004) discard;
  vec3 lp = vS.w > 0.5 ? vL * 1.4 + vec3(0.0, 1.62, 0.0) : vL; // head in body coordinates (≈ continuous field)
  vec3 q = lp * vec3(2.3, 1.45, 2.3) * vS.y + vec3(vS.x, vS.x * 0.37, vS.x * 0.71);
  vec2 S = smoke(q, uTime);
  if (uFade > 0.0) S = mix(S, smoke(q, uTime - uPeriod), uFade); // wrapped time: seamless crossfade
  // dissolve: towards the silhouette only the densest smoke survives → ragged, breaking-up edges
  float d = smoothstep(0.3 + 0.32 * fres, 0.72 + 0.2 * fres, S.x);
  float patches = 0.35 + 0.95 * smoothstep(0.2, 0.8, S.y);
  float a = 0.36 * env * d * patches * vS.z;
  a *= mix(1.0, 0.75, uLayer); // halo layer: wide, faint smoke envelope
  // subtle temporal grain (screen-door shimmer), ±15 %
  a *= 0.85 + 0.3 * hash(vec3(gl_FragCoord.xy, floor(uTime * 24.0)));
  float dist = length(cameraPosition - vWP);
  a *= 1.0 - smoothstep(6.0, 18.0, dist); // black fog
  float redHigh = smoothstep(0.9, 1.6, vH);
  vec3 col = uCold * (uBase + 0.5 * uWhite) + uRedCol * uRed * 0.35 * redHigh;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uLit);
}`

function mistMaterial(layer: 0 | 1, part: 0 | 1) {
  return new ShaderMaterial({
    vertexShader: MIST_VERT,
    fragmentShader: MIST_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uPeriod: { value: SHADER_PERIOD },
      uLit: { value: 0 },
      uWhite: { value: 0 },
      uRed: { value: 0 },
      uBase: { value: 0.06 },
      uLayer: { value: layer },
      uPart: { value: part },
      uInflate: { value: layer ? 0.16 : 0.03 },
      uWaver: { value: layer ? 1.8 : 1.15 }, // halo wavers a bit more → blurrier, moving edge
      uCold: { value: new Color('#dfe8ff') },
      uRedCol: { value: new Color('#c4101c') },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  })
}

/**
 * NPC crowd: mist silhouettes without arms (4 instanced draw calls: bodies + heads, core + halo layer).
 * Driven by the shared beat clock only — no extra synced state. Every figure has its own deterministic dance
 * "personality" (style, timing, amplitude, wandering intensity, section response, idle motion).
 */
export interface CrowdFigure {
  x: number
  z: number
  /** yaw target (they face this point) */
  lookX?: number
  lookZ?: number
  /** the DJ: leans over the decks, nods on the beat */
  dj?: boolean
}

const hash = (i: number, k: number) => {
  let x = (i * 374761393 + k * 668265263) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

/** deterministic packed layout: behind + around the booth, front kept open for the camera / players */
export function crowdLayout(): CrowdFigure[] {
  const out: CrowdFigure[] = [{ x: 0, z: -0.95, dj: true, lookX: 0, lookZ: 3 }]
  let i = 0
  const add = (x: number, z: number) => {
    const jx = (hash(i, 1) - 0.5) * 0.35, jz = (hash(i, 2) - 0.5) * 0.3
    i++
    out.push({ x: x + jx, z: z + jz, lookX: 0, lookZ: 0.2 })
  }
  // packed rows behind the DJ (facing the booth / camera)
  for (let r = 0; r < 4; r++) {
    const z = -1.9 - r * 0.75
    const n = 7 + (r % 2)
    for (let c = 0; c < n; c++) add((c - (n - 1) / 2) * 0.78 + (r % 2 ? 0 : 0.2), z)
  }
  // sides of the booth
  for (const side of [-1, 1])
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 2; c++) add(side * (2.5 + c * 0.75), -0.9 + r * 0.85)
  // in front of the booth: two arcs closing the ring (facing the DJ). Keeps a ~1.4 m clear gap in front of
  // the table (front edge z = 0.6) for players.
  const arc = (r: number, n: number, deg: number) => {
    for (let k = 0; k < n; k++) {
      const th = ((-deg + (2 * deg * k) / (n - 1)) * Math.PI) / 180
      add(r * Math.sin(th), -0.3 + r * Math.cos(th))
    }
  }
  arc(2.75, 9, 58)
  arc(3.55, 10, 52)
  return out
}

const tmp = new Object3D()
const head = new Object3D()
tmp.add(head)
// yaw first, then pitch / roll in the figure's own frame (lean = towards where it faces)
tmp.rotation.order = 'YXZ'

/** dance styles (weights below): how a figure moves to the music */
const STYLES = ['bounce', 'nod', 'shift', 'sway', 'stand', 'half', 'step'] as const
type Style = (typeof STYLES)[number]
const STYLE_W = [0.22, 0.2, 0.17, 0.13, 0.1, 0.1, 0.08]

interface Persona {
  style: Style
  /** timing offset in beats (on / lagging 50–150 ms / offbeat / slightly ahead), lag in ms resolved per bpm */
  lagMs: number
  off: number
  amp: number
  /** dip sharpness (higher = snappier) */
  sharp: number
  scale: number
  yaw: number
  /** intensity wander: two slow sines per figure */
  wf: [number, number, number, number]
  /** pauses: slow noise frequency / phase / threshold */
  pf: number
  pp: number
  pth: number
  /** section response: groove follow rate (1/s), drop reaction strength, its decay (1/s) */
  rate: number
  drop: number
  dropDecay: number
  /** idle: breathing rate / phase, body yaw drift, head turn */
  br: number
  bp: number
  yf: number
  yp: number
  hf: number
  hp: number
  /** step-in-place / drift */
  stepW: number
  /** v17 build: total height (m) and the derived uniform scale, shoulder / hip / depth ×, head ×, leg / torso ×, slouch, static lean */
  height: number
  k: number
  shoulder: number
  hips: number
  depth: number
  headS: number
  leg: number
  torso: number
  slouch: number
  posture: number
  tilt: number
  /** v17 organic motion: seeds + time scales (s) of the non-periodic noise channels */
  seed: number
  vibeT: number
  turnT: number
  shiftT: number
  /** head bob lag behind the body (ms) */
  headLag: number
}

/** standard normal from two uniforms (Box–Muller) */
const gauss = (u1: number, u2: number) => Math.sqrt(-2 * Math.log(Math.max(1e-6, u1))) * Math.cos(6.2831853 * u2)
/** local-space top of the head for a build (body lathe neck 1.53 → head centre 0.09 above, head radius 0.134) */
const headTop = (leg: number, torso: number, slouch: number, headS: number) => 0.8 * leg + 0.73 * torso - 0.025 * slouch + 0.09 * headS + 0.134 * headS
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** deterministic per-figure body: natural height distribution (+ rare outliers), build, proportions, posture */
function build(i: number, dj: boolean) {
  const h = (k: number) => hash(i, 60 + k)
  const z = gauss(h(0), h(1)) // height z-score
  const outlier = h(2) < 0.07 ? (h(3) < 0.5 ? -1 : 1) * (0.07 + 0.05 * h(4)) : 0
  const height = dj ? 1.78 : clamp(1.72 + 0.068 * z + outlier, 1.55, 1.95)
  const b = clamp(gauss(h(5), h(6)) * 0.45, -1, 1) // build: −1 slim … +1 broad
  const tallB = (height - 1.72) * 0.6 // taller → slightly broader
  const shoulder = clamp(1 + 0.11 * b + tallB + 0.04 * (h(7) - 0.5), 0.86, 1.2)
  const hips = clamp(1 + 0.08 * b + 0.07 * (h(8) - 0.5), 0.88, 1.14)
  const depth = clamp(1 + 0.12 * b + 0.06 * (h(9) - 0.5), 0.86, 1.18)
  const headS = clamp(1 + 0.045 * gauss(h(10), h(11)) - 0.03 * (height - 1.72) / 0.07 * 0.3, 0.9, 1.1)
  const leg = clamp(1 + 0.035 * gauss(h(12), h(13)), 0.93, 1.07)
  const torso = clamp(2 - leg + 0.02 * (h(14) - 0.5), 0.93, 1.07) // longer legs ↔ shorter torso (same overall)
  const slouch = dj ? 0.3 : h(15) < 0.35 ? 0.4 + 0.6 * h(16) : 0.15 * h(16)
  const posture = dj ? 0 : 0.035 * gauss(h(17), h(18)) + 0.02 * slouch // static forward / backward lean (rad)
  const tilt = dj ? 0 : 0.018 * gauss(h(19), h(20)) // static sideways list
  const k = height / headTop(leg, torso, slouch, headS)
  return { height, k, shoulder, hips, depth, headS, leg, torso, slouch, posture, tilt }
}

function persona(i: number, f: CrowdFigure): Persona {
  const h = (k: number) => hash(i, 20 + k)
  let x = h(0) * STYLE_W.reduce((a, b) => a + b, 0), si = 0
  while (si < STYLES.length - 1 && (x -= STYLE_W[si]) > 0) si++
  const t = h(1)
  const timing = t < 0.5 ? { lagMs: 0, off: 0 } : t < 0.8 ? { lagMs: 50 + 100 * h(2), off: 0 } : t < 0.92 ? { lagMs: 0, off: 0.5 } : { lagMs: -(15 + 25 * h(2)), off: 0 }
  return {
    style: f.dj ? 'nod' : STYLES[si],
    ...(f.dj ? { lagMs: 0, off: 0 } : timing),
    amp: f.dj ? 1.0 : 0.55 + 0.75 * h(3),
    sharp: 4 + 5 * h(4),
    scale: f.dj ? 1.0 : 0.92 + 0.16 * hash(i, 5),
    yaw: Math.atan2((f.lookX ?? 0) - f.x, (f.lookZ ?? 0) - f.z) + (hash(i, 6) - 0.5) * 0.6,
    wf: [0.025 + 0.06 * h(5), h(6) * 6.28, 0.07 + 0.09 * h(7), h(8) * 6.28],
    pf: 0.02 + 0.04 * h(9),
    pp: h(10) * 6.28,
    pth: f.dj ? -2 : 0.55 + 0.35 * h(11),
    rate: 0.25 + 2.5 * h(12) * h(12),
    drop: f.dj ? 0.6 : h(13) < 0.3 ? 0.8 + 0.4 * h(14) : 0.15 * h(14),
    dropDecay: 0.2 + 0.6 * h(15),
    br: 0.22 + 0.12 * h(16),
    bp: h(17) * 6.28,
    yf: 0.05 + 0.1 * h(18),
    yp: h(19) * 6.28,
    hf: 0.04 + 0.07 * h(20),
    hp: h(21) * 6.28,
    stepW: 0.03 + 0.04 * h(22),
    ...build(i, !!f.dj),
    seed: hash(i, 90) * 97.3,
    vibeT: 14 + 30 * hash(i, 91),
    turnT: 6 + 8 * hash(i, 92),
    shiftT: 3.5 + 4 * hash(i, 93),
    headLag: f.dj ? 20 : 25 + 70 * hash(i, 94),
  }
}

/** non-periodic smooth 1D value noise in −1 … 1 (quintic), seeded per channel; float64 time on the CPU */
const vn = (t: number, seed: number) => {
  const i = Math.floor(t), f = t - i, u = f * f * f * (f * (f * 6 - 15) + 10)
  const a = hash(i, seed | 0), b = hash(i + 1, seed | 0)
  return (a + (b - a) * u) * 2 - 1
}
const fbmN = (t: number, seed: number) => 0.7 * vn(t, seed) + 0.3 * vn(t * 2.13 + 17.1, seed + 7)

/** kick-locked dip: sharp drop at the beat, smooth recovery (x = beat phase 0..1) */
const dipAt = (x: number, k: number) => Math.exp(-x * k) - Math.exp(-k)
const fr = (v: number) => ((v % 1) + 1) % 1

export const Crowd: React.FC<{ figures?: CrowdFigure[] }> = ({ figures }) => {
  const list = useMemo(() => figures ?? crowdLayout(), [figures])
  const N = list.length
  const bodies = useRef<InstancedMesh>(null)
  const heads = useRef<InstancedMesh>(null)
  const bodies2 = useRef<InstancedMesh>(null)
  const heads2 = useRef<InstancedMesh>(null)
  // [body core, head core, body halo, head halo] — one program (same shader), uPart selects the build path
  const mats = useMemo(() => [mistMaterial(0, 0), mistMaterial(0, 1), mistMaterial(1, 0), mistMaterial(1, 1)], [])
  // crowd white flash: own envelope, re-triggered at most every 250 ms (≤ 4 Hz) on rising rig hits
  const white = useRef({ v: 0, last: -1e9, prev: 0 })
  // beat clock: 16th-step counter of the heard events + time since the last step
  const clk = useRef({ step: -1, at: 0 })

  const geo = useMemo(() => {
    // lathe profile: feet → hips → waist → shoulders → neck (scaled flat in z → broad shoulders)
    const prof = [[0.01, 0], [0.12, 0.03], [0.13, 0.4], [0.17, 0.8], [0.165, 1.0], [0.21, 1.22], [0.22, 1.34], [0.17, 1.43], [0.07, 1.47], [0.055, 1.53]]
    // resample the profile to ~even 9 cm steps → enough vertices for a smooth wavering silhouette
    const pts: Vector2[] = []
    for (let k = 0; k < prof.length - 1; k++) {
      const [x0, y0] = prof[k], [x1, y1] = prof[k + 1]
      const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.09))
      for (let j = 0; j < steps; j++) pts.push(new Vector2(x0 + ((x1 - x0) * j) / steps, y0 + ((y1 - y0) * j) / steps))
    }
    pts.push(new Vector2(prof[prof.length - 1][0], prof[prof.length - 1][1]))
    const body = new LatheGeometry(pts, 9)
    body.scale(1, 1, 0.68)
    body.computeVertexNormals()
    const h = new SphereGeometry(0.12, 9, 7)
    h.scale(1, 1.12, 1)
    // per-figure mist variation (shared by both layers: same instance order)
    const P = list.map((f, i) => persona(i, f))
    const mist = new Float32Array(N * 4), bld = new Float32Array(N * 4), shp = new Float32Array(N * 4), dynA = new Float32Array(N * 4)
    for (let i = 0; i < N; i++) {
      const q = P[i]
      // v17: wider per-figure spread of waver speed / scale, plus its own amplitude
      mist.set([hash(i, 40), 0.5 + 1.0 * hash(i, 41), 0.72 + 0.65 * hash(i, 42), 0.75 + 0.55 * hash(i, 43)], i * 4)
      bld.set([q.shoulder, q.hips, q.depth, q.headS], i * 4)
      shp.set([q.leg, q.torso, q.slouch, hash(i, 44) * 53.7 + 1.3], i * 4)
    }
    const aMist = new InstancedBufferAttribute(mist, 4), aBuild = new InstancedBufferAttribute(bld, 4), aShape = new InstancedBufferAttribute(shp, 4)
    const aDyn = new InstancedBufferAttribute(dynA, 4)
    aDyn.setUsage(DynamicDrawUsage)
    for (const g of [body, h]) { g.setAttribute('aMist', aMist); g.setAttribute('aBuild', aBuild); g.setAttribute('aShape', aShape); g.setAttribute('aDyn', aDyn) }
    return { body, h, P, aDyn }
  }, [N, list])

  const P = geo.P
  // per-figure dynamic state: followed groove level, drop excitement, step side
  const dyn = useMemo(() => list.map(() => ({ g: 0, ex: 0 })), [list])

  useLayoutEffect(() => {
    for (const m of [bodies.current, heads.current, bodies2.current, heads2.current]) if (m) m.frustumCulled = false
  }, [])

  useFrame((_, delta) => {
    const B = bodies.current, H = heads.current
    if (!B || !H) return
    // ---- mist uniforms ----
    const W = white.current
    const now = performance.now()
    W.v *= Math.exp(-delta * 14)
    if (beat.whiteHit > 0.5 && W.prev <= 0.5 && now - W.last >= 250) { W.v = Math.max(W.v, beat.whiteHit); W.last = now }
    W.prev = beat.whiteHit
    const litG = beat.lit * (1 - beat.preDrop)
    const wv = Math.min(1, W.v + 0.8 * beat.dropFlash)
    meter('crowdWhite', wv)
    beat.whiteEnv = wv
    meter('crowdRed', beat.redHit)
    const sc = shaderClock(now)
    for (const m of mats) {
      m.uniforms.uTime.value = sc.t
      m.uniforms.uFade.value = sc.fade
      m.uniforms.uLit.value = litG
      m.uniforms.uWhite.value = wv
      m.uniforms.uRed.value = Math.min(1, beat.redHit)
      m.uniforms.uBase.value = 0.08 + 0.05 * beat.energy * (1 - beat.breakAmt) + 0.05 * beat.breakAmt
    }
    if (import.meta.env.DEV) { // dev screenshots: constant, brighter mist to inspect shapes / motion (stripped from builds)
      const bo = (globalThis as Record<string, unknown>).__crowdBoost as number | undefined
      if (bo) for (const m of mats) { m.uniforms.uLit.value = 1; m.uniforms.uBase.value = bo; m.uniforms.uWhite.value = 0; m.uniforms.uRed.value = 0 }
    }
    // ---- beat clock (beats), locked to the heard steps ----
    const bpm = beat.bpm || 140
    const s16ms = 15000 / bpm
    const C = clk.current
    if (beat.step !== C.step) { C.step = beat.step; C.at = now }
    const beats = (Math.max(0, C.step) + Math.min(1.5, (now - C.at) / s16ms)) / 4
    const T = now / 1000
    const target = beat.lit * (1 - beat.breakAmt) * (0.55 + 0.6 * beat.energy)
    const dt = Math.min(0.1, delta)
    const dynA = geo.aDyn.array as Float32Array
    for (let i = 0; i < N; i++) {
      const f = list[i], p = P[i], d = dyn[i]
      // section response: each figure follows the groove level at its own rate (breaks calm down unevenly)
      d.g += (target - d.g) * Math.min(1, dt * p.rate)
      d.ex = Math.max(d.ex * Math.exp(-dt * p.dropDecay), p.drop * beat.dropFlash)
      // v17: intensity drifts on a slow, non-periodic noise (tens of seconds: getting into it / calming down);
      // micro-pauses (1–2 s of stillness) and rarer longer rests come from their own noise channels
      const vibe = 0.15 + 0.95 * smooth01((fbmN(T / p.vibeT + p.seed, i * 13 + 1) * 0.5 + 0.5 - 0.2) / 0.6)
      const micro = 1 - 0.85 * smooth01((vn(T / 3.2 + p.seed * 1.7, i * 13 + 2) - (p.pth * 0.4 + 0.42)) / 0.12)
      const rest = 1 - smooth01((vn(T / (28 + 20 * p.pf * 25) + p.seed, i * 13 + 3) - 0.62 - 0.25 * (p.pth - 0.55)) / 0.15)
      const pause = f.dj ? 1 : micro * rest
      const I = Math.max(0, d.g * vibe * pause * p.amp + 0.5 * d.ex) * beat.lit
      // timing: own lag / offbeat; half-timers move on every other beat
      const b = beats - (p.lagMs * bpm) / 60000 + p.off
      const x1 = fr(b), x2 = fr(b / 2)
      const dip = p.style === 'half' ? dipAt(x2, p.sharp * 0.6) : dipAt(x1, p.sharp)
      // head bobs a little after the body (own lag 25–95 ms), softer attack
      const hb = b - (p.headLag * bpm) / 60000
      const hdip = p.style === 'half' ? dipAt(fr(hb / 2), p.sharp * 0.5) : dipAt(fr(hb), p.sharp * 0.75)
      let y = 0, pitch = 0, roll = 0, sx = 0, sz = 0, nod = 0, yawD = 0
      switch (p.style) {
        case 'bounce': y = -0.07 * dip; pitch = 0.06 * dip; nod = 0.18 * hdip; break
        case 'nod': y = -0.012 * dip; pitch = 0.015 * dip; nod = (f.dj ? 0.32 : 0.26) * hdip; break
        case 'shift': { const w = Math.sin(Math.PI * b); sx = 0.05 * w; roll = -0.06 * w; y = -0.025 * Math.abs(w) * dip; nod = 0.08 * hdip; break }
        case 'sway': { const w = Math.sin((Math.PI * b) / 2); sx = 0.035 * w; roll = -0.08 * w; yawD = 0.1 * w; nod = 0.05 * hdip; break }
        case 'stand': nod = 0.04 * hdip; break
        case 'half': y = -0.06 * dip; pitch = 0.05 * dip; nod = 0.2 * hdip; break
        case 'step': { const w = Math.sin(Math.PI * b); sx = p.stepW * w; y = -0.03 * dip; roll = -0.04 * w; yawD = 0.2 * vn(T / 20 + p.seed, i * 13 + 4); nod = 0.1 * hdip; break }
      }
      // idle, independent of the beat: breathing (rate drifts a little), weight shifts, slow body rotation, occasional
      // look-around turns, head turns — all non-periodic noise
      const breath = Math.sin(T * p.br * 6.283 + p.bp + 0.8 * vn(T / 11 + p.seed, i * 13 + 5))
      const ws = f.dj ? 0 : fbmN(T / p.shiftT + p.seed * 0.7, i * 13 + 6)
      const look = vn(T / p.turnT + p.seed * 1.3, i * 13 + 7)
      const turn = f.dj ? 0 : 0.55 * (smooth01((look - 0.55) / 0.3) - smooth01((-0.55 - look) / 0.3))
      const yawIdle = 0.09 * fbmN(T / (6 + 6 * p.yf * 10) + p.seed, i * 13 + 8) + turn
      const hs = fbmN(T / (4 + 40 * p.hf) + p.seed * 2.1, i * 13 + 9)
      const headTurn = 0.45 * hs * Math.abs(hs) + 0.5 * turn
      const k = p.k
      const lean = (f.dj ? 0.22 : 0) + p.posture
      const ca = Math.cos(p.yaw), sa = Math.sin(p.yaw)
      const shiftX = I * sx + 0.028 * ws // weight shift moves the hips sideways (local x)
      tmp.position.set(f.x + shiftX * ca, I * y, f.z - shiftX * sa + I * sz)
      tmp.rotation.set(lean + I * pitch + 0.006 * breath, p.yaw + yawIdle + I * yawD, I * roll + p.tilt - 0.025 * ws)
      tmp.scale.set(k, k * (1 + 0.007 * breath), k)
      // head sits on this figure's neck (proportions + slouch move it), size handled in the shader
      head.position.set(0, 0.8 * p.leg + 0.73 * p.torso - 0.025 * p.slouch + 0.09 * p.headS, 0.02 + 0.07 * p.slouch)
      head.rotation.set((f.dj ? 0.2 : 0) + I * nod + 0.02 * breath + 0.08 * p.slouch, headTurn * (f.dj ? 0.3 : 1), 0.04 * ws)
      dynA[i * 4] = I
      dynA[i * 4 + 1] = ws
      tmp.updateMatrixWorld(true)
      B.setMatrixAt(i, tmp.matrixWorld)
      H.setMatrixAt(i, head.matrixWorld)
    }
    B.instanceMatrix.needsUpdate = true
    H.instanceMatrix.needsUpdate = true
    geo.aDyn.needsUpdate = true
    // halo layer shares the same instance matrices
    for (const [src, dst] of [[B, bodies2.current], [H, heads2.current]] as const) {
      if (!dst) continue
      ;(dst.instanceMatrix.array as Float32Array).set(src.instanceMatrix.array as Float32Array)
      dst.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <group>
      <instancedMesh ref={bodies} args={[geo.body, mats[0], N]} renderOrder={2} />
      <instancedMesh ref={heads} args={[geo.h, mats[1], N]} renderOrder={2} />
      <instancedMesh ref={bodies2} args={[geo.body, mats[2], N]} renderOrder={3} />
      <instancedMesh ref={heads2} args={[geo.h, mats[3], N]} renderOrder={3} />
    </group>
  )
}

const smooth01 = (v: number) => { const x = Math.min(1, Math.max(0, v)); return x * x * (3 - 2 * x) }
