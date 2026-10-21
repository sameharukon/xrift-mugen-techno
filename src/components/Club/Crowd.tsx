import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, Color, InstancedBufferAttribute, InstancedMesh, LatheGeometry, Object3D, ShaderMaterial, SphereGeometry, Vector2 } from 'three'
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
/** per figure: x = noise phase offset, y = drift speed ×, z = noise scale × (no two figures waver alike) */
attribute vec3 aMist;
varying vec3 vN;
varying vec3 vWP;
varying float vH;
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
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec3 n = normalize(mat3(m) * normal);
  vec4 wp = m * vec4(position, 1.0);
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
  float amp = uWaver * (0.35 + 0.65 * edge) * (0.25 + 0.75 * up);
  wp.xyz += n * ((d - 0.45) * 0.07 * amp + uInflate);
  // whole figure drifts a few cm like smoke, more at the top
  wp.x += (d2 - 0.5) * 0.05 * up * uWaver;
  wp.z += (d3 - 0.5) * 0.04 * up * uWaver;
  // wisps trail upward at the edges of the upper body
  wp.y += smoothstep(0.55, 0.95, d) * 0.07 * edge * up * up * uWaver;
  vN = n;
  vWP = wp.xyz;
  vH = wp.y;
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
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
/** x: wisp density fbm, y: edge-tear noise — scrolled by one (wrapped) time value */
vec2 mistNoise(vec3 p, float t) {
  vec3 q = p * 1.8 + vec3(0.0, -t * 0.4, t * 0.15);
  return vec2(0.55 * vnoise(q) + 0.3 * vnoise(q * 2.1 + 7.1) + 0.15 * vnoise(q * 4.3 - 3.7), vnoise(p * 3.4 + vec3(1.3, -t * 0.6, 4.1)));
}
void main() {
  if (uLit < 0.002) discard;
  vec3 V = normalize(cameraPosition - vWP);
  float fres = 1.0 - abs(dot(normalize(vN), V));
  // soft band just inside the outline that fades out again AT the silhouette edge → no crisp contour line
  // very broad, low-contrast falloff: no rim band (→ no rings on heads); density fades out well before
  // the silhouette so the outline dissolves instead of reading as an edge
  float body = 1.0 - smoothstep(0.15, 0.95, fres);           // thickest where we look through the middle
  float rim = smoothstep(0.0, 0.8, fres) * (1.0 - smoothstep(0.35, 0.9, fres));
  vec2 N = mistNoise(vWP, uTime);
  if (uFade > 0.0) N = mix(N, mistNoise(vWP, uTime - uPeriod), uFade); // wrapped time: seamless crossfade
  float wisp = smoothstep(0.2, 0.9, N.x);
  // edge breakup: towards the outline the density is gated by a second scrolling noise
  float tear = smoothstep(0.25, 0.75, N.y);
  // core almost see-through; rim haze; noise tears it into drifting wisps; feet dissolve into the floor haze
  float a = (0.09 * body + 0.14 * rim) * (0.2 + 1.0 * wisp) * mix(1.0, tear, smoothstep(0.3, 0.9, fres));
  // feet / legs nearly invisible: density ramps in from the knees up
  a *= smoothstep(0.35, 1.15, vH);
  a *= mix(1.0, 0.8, uLayer); // halo layer: much wider but similar density → shape only vaguely suggested
  float dist = length(cameraPosition - vWP);
  a *= 1.0 - smoothstep(6.0, 18.0, dist); // black fog
  // red comes from above/behind now (booth/truss level) → faint on shoulders/heads, none at the feet
  float redHigh = smoothstep(0.9, 1.6, vH);
  vec3 col = uCold * (uBase + 0.5 * uWhite) + uRedCol * uRed * 0.35 * redHigh;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uLit);
}`

function mistMaterial(layer: 0 | 1) {
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
  }
}

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
  const mats = useMemo(() => [mistMaterial(0), mistMaterial(1)], [])
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
    const mist = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      mist[i * 3] = hash(i, 40)
      mist[i * 3 + 1] = 0.65 + 0.7 * hash(i, 41)
      mist[i * 3 + 2] = 0.8 + 0.45 * hash(i, 42)
    }
    body.setAttribute('aMist', new InstancedBufferAttribute(mist, 3))
    h.setAttribute('aMist', new InstancedBufferAttribute(mist, 3))
    return { body, h }
  }, [N])

  const P = useMemo(() => list.map((f, i) => persona(i, f)), [list])
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
    // ---- beat clock (beats), locked to the heard steps ----
    const bpm = beat.bpm || 140
    const s16ms = 15000 / bpm
    const C = clk.current
    if (beat.step !== C.step) { C.step = beat.step; C.at = now }
    const beats = (Math.max(0, C.step) + Math.min(1.5, (now - C.at) / s16ms)) / 4
    const T = now / 1000
    const target = beat.lit * (1 - beat.breakAmt) * (0.55 + 0.6 * beat.energy)
    const dt = Math.min(0.1, delta)
    for (let i = 0; i < N; i++) {
      const f = list[i], p = P[i], d = dyn[i]
      // section response: each figure follows the groove level at its own rate (breaks calm down unevenly)
      d.g += (target - d.g) * Math.min(1, dt * p.rate)
      d.ex = Math.max(d.ex * Math.exp(-dt * p.dropDecay), p.drop * beat.dropFlash)
      // intensity wanders slowly; occasional pauses (stillness)
      const wander = 0.6 + 0.25 * Math.sin(T * p.wf[0] * 6.283 + p.wf[1]) + 0.15 * Math.sin(T * p.wf[2] * 6.283 + p.wf[3])
      const pause = 1 - smooth01((Math.sin(T * p.pf * 6.283 + p.pp) * 0.5 + 0.5 - p.pth) / 0.12)
      const I = Math.max(0, d.g * wander * pause * p.amp + 0.5 * d.ex) * beat.lit
      // timing: own lag / offbeat; half-timers move on every other beat
      const b = beats - (p.lagMs * bpm) / 60000 + p.off
      const x1 = fr(b), x2 = fr(b / 2)
      const dip = p.style === 'half' ? dipAt(x2, p.sharp * 0.6) : dipAt(x1, p.sharp)
      let y = 0, pitch = 0, roll = 0, sx = 0, sz = 0, nod = 0, yawD = 0
      switch (p.style) {
        case 'bounce': y = -0.07 * dip; pitch = 0.06 * dip; nod = 0.18 * dip; break
        case 'nod': y = -0.012 * dip; pitch = 0.015 * dip; nod = (f.dj ? 0.32 : 0.26) * dip; break
        case 'shift': { const w = Math.sin(Math.PI * b); sx = 0.05 * w; roll = -0.06 * w; y = -0.025 * Math.abs(w) * dip; nod = 0.08 * dip; break }
        case 'sway': { const w = Math.sin((Math.PI * b) / 2); sx = 0.035 * w; roll = -0.08 * w; yawD = 0.1 * w; nod = 0.05 * dip; break }
        case 'stand': nod = 0.04 * dip; break
        case 'half': y = -0.06 * dip; pitch = 0.05 * dip; nod = 0.2 * dip; break
        case 'step': { const w = Math.sin(Math.PI * b); sx = p.stepW * w; y = -0.03 * dip; roll = -0.04 * w; yawD = 0.2 * Math.sin(T * 0.05 + p.yp); nod = 0.1 * dip; break }
      }
      // idle, independent of the beat: breathing, slow body rotation, head turns
      const breath = Math.sin(T * p.br * 6.283 + p.bp)
      const yawIdle = 0.07 * Math.sin(T * p.yf * 6.283 + p.yp) + 0.04 * Math.sin(T * p.yf * 2.7 + p.bp)
      const hs = Math.sin(T * p.hf * 6.283 + p.hp)
      const headTurn = 0.4 * hs * hs * hs + 0.06 * Math.sin(T * 0.37 + p.hp)
      const s = p.scale
      const lean = f.dj ? 0.22 : 0
      tmp.position.set(f.x + I * sx * Math.cos(p.yaw), I * y, f.z - I * sx * Math.sin(p.yaw) + I * sz)
      tmp.rotation.set(lean + I * pitch + 0.006 * breath, p.yaw + yawIdle + I * yawD, I * roll)
      tmp.scale.set(s, s * (1 + 0.007 * breath), s)
      head.position.set(0, 1.62, 0.02)
      head.rotation.set((f.dj ? 0.2 : 0) + I * nod + 0.02 * breath, headTurn * (f.dj ? 0.3 : 1), 0)
      tmp.updateMatrixWorld(true)
      B.setMatrixAt(i, tmp.matrixWorld)
      H.setMatrixAt(i, head.matrixWorld)
    }
    B.instanceMatrix.needsUpdate = true
    H.instanceMatrix.needsUpdate = true
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
      <instancedMesh ref={heads} args={[geo.h, mats[0], N]} renderOrder={2} />
      <instancedMesh ref={bodies2} args={[geo.body, mats[1], N]} renderOrder={3} />
      <instancedMesh ref={heads2} args={[geo.h, mats[1], N]} renderOrder={3} />
    </group>
  )
}

const smooth01 = (v: number) => { const x = Math.min(1, Math.max(0, v)); return x * x * (3 - 2 * x) }
