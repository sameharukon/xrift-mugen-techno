import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, CapsuleGeometry, Color, InstancedMesh, LatheGeometry, Object3D, ShaderMaterial, SphereGeometry, Vector2 } from 'three'
import { beat } from '../../techno/beat'
import { meter } from './index'

// ---------------------------------------------------------------- mist material
/**
 * "人間の輪郭がぼんやりあるもや": additive, depthWrite off (no sorting issues across instances),
 * fresnel rim → soft glowing edges with a see-through core, time-scrolled 3D value-noise fbm → wispy drift.
 * Two layers on body + head (core + inflated faint halo; arms core only) blur the outline. Colour follows the rig:
 * pale cold white rim + white hits from behind, deep red from the floor pulse below. 0 when lit = 0.
 */
const MIST_VERT = /* glsl */ `
uniform float uInflate;
uniform float uTime;
uniform float uWaver;
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
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec3 n = normalize(mat3(m) * normal);
  vec4 wp = m * vec4(position, 1.0);
  // ---- wavering outline (smoke / heat haze): noise displacement mostly along the normal ----
  // per-instance phase from the instance position; field scrolls upward (rising flow)
  vec3 seed = vec3(instanceMatrix[3].x * 1.7, 0.0, instanceMatrix[3].z * 1.3);
  float up = clamp(wp.y / 1.75, 0.0, 1.0);
  vec3 q = wp.xyz * vec3(2.6, 1.6, 2.6) + seed + vec3(0.0, -uTime * 0.55, uTime * 0.08);
  float d = vnoiseV(q) * 0.65 + vnoiseV(q * 2.1 + 4.3) * 0.35;      // 0..1
  float d2 = vnoiseV(q * 0.7 + vec3(9.1, -uTime * 0.25, 2.7));      // slow, large-scale sway
  // stronger at the silhouette (normal ⟂ view) and towards the upper body; feet stay planted
  vec3 toCam = normalize(cameraPosition - wp.xyz);
  float edge = 1.0 - abs(dot(n, toCam));
  float amp = uWaver * (0.35 + 0.65 * edge) * (0.25 + 0.75 * up);
  wp.xyz += n * ((d - 0.45) * 0.07 * amp + uInflate);
  // whole figure drifts a few cm like smoke, more at the top
  wp.x += (d2 - 0.5) * 0.05 * up * uWaver;
  wp.z += (vnoiseV(q * 0.6 + 13.7) - 0.5) * 0.04 * up * uWaver;
  // wisps trail upward at the edges of the upper body
  wp.y += smoothstep(0.55, 0.95, d) * 0.07 * edge * up * up * uWaver;
  vN = n;
  vWP = wp.xyz;
  vH = wp.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const MIST_FRAG = /* glsl */ `
uniform float uTime;
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
void main() {
  if (uLit < 0.002) discard;
  vec3 V = normalize(cameraPosition - vWP);
  float fres = 1.0 - abs(dot(normalize(vN), V));
  // soft band just inside the outline that fades out again AT the silhouette edge → no crisp contour line
  // very broad, low-contrast falloff: no rim band (→ no rings on heads); density fades out well before
  // the silhouette so the outline dissolves instead of reading as an edge
  float body = 1.0 - smoothstep(0.15, 0.95, fres);           // thickest where we look through the middle
  float rim = smoothstep(0.0, 0.8, fres) * (1.0 - smoothstep(0.35, 0.9, fres));
  vec3 q = vWP * 1.8 + vec3(0.0, -uTime * 0.4, uTime * 0.15);
  float n = 0.55 * vnoise(q) + 0.3 * vnoise(q * 2.1 + 7.1) + 0.15 * vnoise(q * 4.3 - 3.7);
  float wisp = smoothstep(0.2, 0.9, n);
  // edge breakup: towards the outline the density is gated by a second scrolling noise
  float tear = smoothstep(0.25, 0.75, vnoise(vWP * 3.4 + vec3(1.3, -uTime * 0.6, 4.1)));
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
 * NPC crowd: dark low-poly silhouettes (3 instanced draw calls total: bodies, heads, arms).
 * Driven only by the shared beat (same timeline for everyone) — no extra synced state.
 */
export interface CrowdFigure {
  x: number
  z: number
  /** yaw target (they face this point) */
  lookX?: number
  lookZ?: number
  /** the DJ: hands on the decks, nods hardest */
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
  // the table (front edge z = 0.6) where players spawn / reach the Play button.
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
const armL = new Object3D()
const armR = new Object3D()
tmp.add(head, armL, armR)

export const Crowd: React.FC<{ figures?: CrowdFigure[] }> = ({ figures }) => {
  const list = useMemo(() => figures ?? crowdLayout(), [figures])
  const N = list.length
  const bodies = useRef<InstancedMesh>(null)
  const heads = useRef<InstancedMesh>(null)
  const arms = useRef<InstancedMesh>(null)
  const bodies2 = useRef<InstancedMesh>(null)
  const heads2 = useRef<InstancedMesh>(null)
    const mats = useMemo(() => [mistMaterial(0), mistMaterial(1)], [])
  // crowd white flash: own envelope, re-triggered at most every 250 ms (≤ 4 Hz) on rising rig hits
  const white = useRef({ v: 0, last: -1e9, prev: 0 })
  const hands = useRef(0)
  const lastDrop = useRef(0)

  const geo = useMemo(() => {
    // lathe profile: feet → hips → waist → shoulders → neck (scaled flat in z → broad shoulders)
    // softer, rounder profile (fewer hard corners → reads as a vague outline in the mist)
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
    const a = new CapsuleGeometry(0.045, 0.52, 2, 6, 4) // 4 length segments → smooth arm deformation
    a.translate(0, -0.3, 0) // pivot at the shoulder
    return { body, h, a }
  }, [])

  const params = useMemo(() => list.map((f, i) => ({
    phase: hash(i, 3) * 0.18 - 0.09, // slight timing spread around the kick
    amp: f.dj ? 1.2 : 0.45 + 0.6 * hash(i, 4),
    scale: f.dj ? 1.0 : 0.92 + 0.16 * hash(i, 5),
    yaw: Math.atan2((f.lookX ?? 0) - f.x, (f.lookZ ?? 0) - f.z) + (hash(i, 6) - 0.5) * 0.6,
    raiser: !f.dj && hash(i, 7) < 0.4,
    oneArm: hash(i, 8) < 0.5,
    sway: hash(i, 9) * Math.PI * 2,
  })), [list])

  useLayoutEffect(() => {
    for (const m of [bodies.current, heads.current, arms.current, bodies2.current, heads2.current]) if (m) m.frustumCulled = false
  }, [])

  useFrame((_, delta) => {
    const B = bodies.current, H = heads.current, A = arms.current
    if (!B || !H || !A) return
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
    for (const m of mats) {
      m.uniforms.uTime.value = now / 1000
      m.uniforms.uLit.value = litG
      m.uniforms.uWhite.value = wv
      m.uniforms.uRed.value = Math.min(1, beat.redHit)
      m.uniforms.uBase.value = 0.08 + 0.05 * beat.energy * (1 - beat.breakAmt) + 0.05 * beat.breakAmt
    }
    const bpm = beat.bpm || 140
    const ph = (beat.time * bpm) / 60
    const groove = beat.lit * (1 - beat.breakAmt)
    // hands up after a drop, fading over ~8 s
    if (beat.dropFlash > 0.9 && performance.now() - lastDrop.current > 2000) { hands.current = 1; lastDrop.current = performance.now() }
    hands.current = Math.max(0, hands.current - delta / 8)
    const riserHands = beat.riser > 0.7 ? (beat.riser - 0.7) / 0.3 : 0
    for (let i = 0; i < N; i++) {
      const f = list[i], p = params[i]
      // bounce: sharp down-beat dip (kick), smooth recovery
      const x = ((ph + p.phase) % 1 + 1) % 1
      const dip = Math.exp(-x * 6) * groove
      const sway = Math.sin(beat.time * 0.9 + p.sway) * (0.03 + 0.05 * beat.breakAmt) * beat.lit
      tmp.position.set(f.x, -0.06 * p.amp * dip, f.z)
      tmp.rotation.set(0.05 * p.amp * dip, p.yaw + sway, sway * 0.5)
      tmp.scale.setScalar(p.scale)
      head.position.set(0, 1.62, 0.02)
      head.rotation.set((f.dj ? 0.35 : 0.22) * p.amp * dip + (f.dj ? 0.25 : 0), 0, 0)
      armL.position.set(-0.21, 1.33, 0)
      armR.position.set(0.21, 1.33, 0)
      if (f.dj) {
        // hands forward on the decks, small pumps on the kick
        armL.rotation.set(-1.05 - 0.1 * dip, 0, -0.12)
        armR.rotation.set(-1.0 - 0.15 * dip + 0.1 * Math.sin(beat.time * 2), 0, 0.12)
      } else {
        const up = p.raiser ? Math.min(1, hands.current * 1.5 + riserHands) : 0
        const pump = up * 0.25 * dip
        // rotation.z < 0 swings the left arm outward/up, > 0 the right arm
        armL.rotation.set(0.08, 0, -(0.12 + up * (p.oneArm ? 0 : 2.6 - pump)))
        armR.rotation.set(0.08, 0, 0.12 + up * (2.7 - pump))
      }
      tmp.updateMatrixWorld(true)
      B.setMatrixAt(i, tmp.matrixWorld)
      H.setMatrixAt(i, head.matrixWorld)
      A.setMatrixAt(i * 2, armL.matrixWorld)
      A.setMatrixAt(i * 2 + 1, armR.matrixWorld)
    }
    B.instanceMatrix.needsUpdate = true
    H.instanceMatrix.needsUpdate = true
    A.instanceMatrix.needsUpdate = true
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
      <instancedMesh ref={arms} args={[geo.a, mats[0], N * 2]} renderOrder={2} />
      <instancedMesh ref={bodies2} args={[geo.body, mats[1], N]} renderOrder={3} />
      <instancedMesh ref={heads2} args={[geo.h, mats[1], N]} renderOrder={3} />
    </group>
  )
}
