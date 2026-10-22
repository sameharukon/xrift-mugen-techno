import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending, BoxGeometry, type BufferGeometry, Color, CylinderGeometry, DoubleSide, Euler, Fog, Group, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PointLight, Quaternion, ShaderMaterial, SphereGeometry, TorusGeometry, Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { allocHalo, envOn, fx, setHalo, shaderClock, TINTS } from './fx'
import { beat } from '../../techno/beat'
import { BRUSH_TILE, concreteTexture, hazeNoise, radialTexture } from './textures'
import { metalUV } from './geo'
import { TUBE_DECAY, TUBE_HALO_I, TUBE_HALO_R, TUBE_IDLE, tubeDir, tubeGeometry, tubeMaterial, WALL_TUBES, wallFixtures, wallTubeMatrix } from './tubes'
import { brushedMetal } from './metal'

/**
 * Underground / warehouse look: monochrome cold white + a single deep red for the low end.
 * Everything here is black when the music is off (all outputs are scaled by beat.lit).
 * Strobe-like gates never run faster than eighth notes (≈4.7 Hz at 140 BPM).
 */
export const PALETTE = {
  cold: new Color('#dfe8ff'),
  white: new Color('#ffffff'),
  red: new Color('#c4101c'),
  concrete: '#666666',
  steel: '#1d1e20',
}

const tmpCol = new Color()
/** deterministic 0..1 hash (same flicker for everyone) */
const hash2 = (a: number, b: number) => {
  let x = (a * 374761393 + b * 668265263) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

// ---------------------------------------------------------------- concrete material helper
export function useConcrete(repeat: number) {
  return useMemo(() => {
    const t = concreteTexture().clone()
    t.repeat.set(repeat, repeat)
    t.needsUpdate = true
    return t
  }, [repeat])
}

// ---------------------------------------------------------------- hit helpers ("バチバチ")
/**
 * Hard, snappy hits: instant attack, short exponential decay. Each source is triggered at most once per
 * quarter / offbeat / clap / chase slot, so a single source never flashes faster than ~2.3 Hz in the groove
 * (≤ ~2.3 Hz on chases too, since chases rotate across several sources). All sources are small fixtures.
 */
/** hard per-source cap: a source can't be re-triggered within this window → ≤ 4 Hz no matter what the music does (fills, rolls) */
const REFRACTORY_MS = 250
interface Envs { v: Float32Array; last: Float64Array }
function useEnvelopes(n: number) {
  return useRef<Envs>({ v: new Float32Array(n), last: new Float64Array(n).fill(-1e9) })
}
/** trigger source i (instant attack) unless it fired less than REFRACTORY_MS ago */
function fire(e: Envs, i: number, level: number) {
  const now = performance.now()
  if (now - e.last[i] < REFRACTORY_MS) return
  e.last[i] = now
  e.v[i] = Math.max(e.v[i], level)
}
/** per-frame exponential decay of every envelope */
function decayAll(env: Envs, delta: number, rate: number) {
  const k = Math.exp(-delta * rate)
  for (let i = 0; i < env.v.length; i++) env.v[i] *= k
}
/** blackout gate: everything off while a drop is pending, everything slams when it lands */
const gate = () => beat.lit * (1 - beat.preDrop)

// dev-only flash meter: rising edges above 0.5 per source → max rate in any 1 s window
const flashMeter: Record<string, { on: boolean; t: number[]; max: number }> = {}
export function meter(id: string, v: number) {
  if (!import.meta.env.DEV) return
  const m = (flashMeter[id] ??= { on: false, t: [], max: 0 })
  const now = performance.now()
  if (v > 0.5 && !m.on) {
    m.t.push(now)
    while (m.t.length && now - m.t[0] > 1000) m.t.shift()
    m.max = Math.max(m.max, m.t.length)
  }
  m.on = v > 0.5
}
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__flashMeter = flashMeter

/** shared trigger tracking (one per component instance) */
function useTriggers() {
  return useRef({ step: -1, kickN: 0, clapN: 0, half: -1, clapCount: 0 })
}

// ---------------------------------------------------------------- floor: low red kick slam
export interface FloorGlowProps {
  position?: [number, number, number]
  size?: number
  /** red point light range */
  distance?: number
  /** height of the red light (raise it to light the crowd from above instead of the floor) */
  lightHeight?: number
  /** red light peak intensity */
  peak?: number
  /** max opacity of the floor pool decal (0 → no pool) */
  poolMax?: number
}

/** kick → hard deep-red pool on the concrete (point light + additive pool), black between kicks */
export const FloorGlow: React.FC<FloorGlowProps> = ({ position = [0, 0, 0], size = 9, distance = 9, lightHeight = 0.6, peak = 40, poolMax = 0.95 }) => {
  const light = useRef<PointLight>(null)
  const pool = useRef<MeshBasicMaterial>(null)
  const tex = useMemo(() => radialTexture(), [])
  const env = useEnvelopes(1)
  const tr = useTriggers()
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    decayAll(env.current, delta, 13) // ~50 ms to half
    if (beat.kickN !== tr.current.kickN) { tr.current.kickN = beat.kickN; if (groove > 0.3) fire(env.current, 0, 1) }
    const breath = beat.breakAmt * (0.06 + 0.04 * Math.sin(beat.time * 1.3)) // breaks: barely-there red
    const k = env.current.v[0] * (0.75 + 0.35 * beat.energy) + breath + 0.08 * beat.bass * groove
    const v = Math.min(1, G * (k + beat.dropFlash * beat.dropFlash))
    meter('floor', v)
    beat.redHit = v
    if (light.current) light.current.intensity = peak * v
    if (pool.current) pool.current.opacity = Math.min(poolMax, poolMax * v)
  })
  return (
    <group position={position}>
      <pointLight ref={light} position={[0, lightHeight, 0]} color={PALETTE.red} distance={distance} decay={1.8} intensity={0} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial ref={pool} color={PALETTE.red} alphaMap={tex} transparent opacity={0} blending={AdditiveBlending}
          depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------- truss: slamming white beams + tubes + strobe fixtures
export interface LightRigProps {
  position?: [number, number, number]
  width?: number
  /** beam cone length (m) */
  beamLength?: number
  /** +1: beams tilt away from +z, -1: beams tilt towards +z (backlighting the crowd towards the camera) */
  tiltDir?: number
  /** truss length override (defaults to width + 1) */
  trussLength?: number
  /** strobe spill light peak / range (small rooms: lower, so the ceiling doesn't flash) */
  spill?: number
  spillDistance?: number
}

const HEADS = 4
const TUBES = 5
const STROBES = 4

// ---- soft volumetric beam: falloff along the length and across the cone, drifting dust, bright source hotspot
const BEAM_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying float vT;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vT = 1.0 - uv.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}`
const BEAM_FRAG = /* glsl */ `
uniform float uI;
uniform float uTime;
uniform vec3 uCol;
uniform sampler2D uNoise;
varying vec3 vW;
varying vec3 vN;
varying float vT;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = abs(dot(normalize(vN), V));
  float soft = facing * facing * (3.0 - 2.0 * facing);
  float along = pow(1.0 - vT, 0.95) * (1.0 - smoothstep(0.8, 1.0, vT)) + 0.03 * (1.0 - vT);
  float n1 = texture2D(uNoise, vec2(vW.x * 0.45 + vW.z * 0.3 + uTime * 0.02, vW.y * 0.35 - uTime * 0.045)).r;
  float n2 = texture2D(uNoise, vec2(vW.z * 1.3 - uTime * 0.05, vW.y * 1.1 + vW.x * 0.6)).g;
  float dust = 0.55 + 0.6 * n1 + 0.35 * (n2 - 0.5);
  float hot = exp(-vT * 16.0);
  float a = uI * (soft * along * dust * 0.75 + hot * (0.35 + 0.65 * soft));
  gl_FragColor = vec4(uCol * a, 1.0);
}`

const _v = new Vector3()
const _w = new Vector3()
const _ax = new Vector3()
const _m4 = new Matrix4()

// v19: nothing on a perfect grid — small deterministic offsets for the heads, strobes and hanging tubes (rigged by hand)
const headX = (i: number, width: number) => (i - (HEADS - 1) / 2) * (width / (HEADS - 1)) + (hash2(i, 501) - 0.5) * 0.14
const strobeX = (i: number, width: number) => (i - (STROBES - 1) / 2) * ((width + 0.6) / (STROBES - 1)) + (hash2(i, 502) - 0.5) * 0.12
/** hanging tube i: centre + a slight hang angle (z) and twist (y); the wires and end caps follow it */
function rigTube(i: number, width: number) {
  const x = (i - (TUBES - 1) / 2) * ((width + 0.4) / TUBES) + (hash2(i, 503) - 0.5) * 0.12
  return { x, y: -0.2 - hash2(i, 504) * 0.05, z: 0.25 + (hash2(i, 505) - 0.5) * 0.03, rz: (hash2(i, 506) - 0.5) * 0.05, ry: (hash2(i, 507) - 0.5) * 0.06 }
}
const rigTubeMatrix = (i: number, width: number, len = 1.2) => {
  const t = rigTube(i, width)
  return new Matrix4().compose(new Vector3(t.x, t.y, t.z), new Quaternion().setFromEuler(new Euler(0, t.ry, Math.PI / 2 + t.rz)), new Vector3(1, len, 1))
}

/** static truss + yokes + strobe housings + tube holders → one merged geometry (one draw) */
function rigStaticGeometry(trussLen: number, width: number) {
  const parts: BufferGeometry[] = []
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const g = new BoxGeometry(w, h, d)
    g.applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz)).setPosition(x, y, z))
    parts.push(g)
  }
  const cyl = (r: number, len: number, x: number, y: number, z: number, rx = 0, rz = 0, seg = 6) => {
    const g = new CylinderGeometry(r, r, len, seg, 1)
    g.applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(rx, 0, rz)).setPosition(x, y, z))
    parts.push(g)
  }
  // box truss 0.3 × 0.3: 4 chords + zig-zag lacing on the 4 faces
  const H = 0.15
  for (const [y, z] of [[H, H], [H, -H], [-H, H], [-H, -H]]) cyl(0.022, trussLen, 0, y, z, 0, Math.PI / 2, 8)
  const seg = Math.round(trussLen / 0.3)
  const step = trussLen / seg
  const diag = Math.hypot(step, 2 * H)
  const ang = Math.atan2(2 * H, step)
  for (let k = 0; k < seg; k++) {
    const x = -trussLen / 2 + (k + 0.5) * step
    const sgn = k % 2 ? 1 : -1
    cyl(0.008, diag, x, 0, H, 0, Math.PI / 2 + sgn * ang)
    cyl(0.008, diag, x, 0, -H, 0, Math.PI / 2 - sgn * ang)
    // top / bottom lacing (in the xz plane)
    const gT = new CylinderGeometry(0.008, 0.008, diag, 5, 1)
    gT.applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(0, sgn * ang, Math.PI / 2)).setPosition(x, H, 0))
    parts.push(gT)
    const gB = gT.clone(); gB.translate(0, -2 * H, 0); parts.push(gB)
  }
  // moving-head bases (clamped under the truss) + yokes
  for (let i = 0; i < HEADS; i++) {
    const x = headX(i, width)
    cyl(0.014, 0.08, x, -H - 0.03, 0) // clamp rod
    box(0.3, 0.07, 0.22, x, -H - 0.1, 0) // base
    box(0.05, 0.03, 0.05, x, -H - 0.06, 0.08)
    box(0.26, 0.025, 0.06, x, -H - 0.15, 0) // yoke bridge
    box(0.025, 0.2, 0.06, x - 0.13, -H - 0.25, 0) // yoke arms
    box(0.025, 0.2, 0.06, x + 0.13, -H - 0.25, 0)
  }
  // strobe housings on top of the truss (each clamped at its own slight angle)
  for (let i = 0; i < STROBES; i++) {
    const x = strobeX(i, width), a = (hash2(i, 508) - 0.5) * 0.06
    box(0.44, 0.17, 0.1, x, H + 0.1, 0.12, a)
    box(0.36, 0.02, 0.04, x, H + 0.2, 0.12, a)
    box(0.05, 0.05, 0.12, x - 0.17, H + 0.03, 0.12)
    box(0.05, 0.05, 0.12, x + 0.17, H + 0.03, 0.12)
  }
  // tube holders: two hanging wires (to the truss's lower chord) + end caps, following each tube's hang
  for (let i = 0; i < TUBES; i++) {
    const M = rigTubeMatrix(i, width, 1)
    for (const s of [-1, 1]) {
      const w = new Vector3(0, s * 0.45, 0).applyMatrix4(M)
      const top = -H + 0.02, len = top - w.y
      cyl(0.004, len, w.x, w.y + len / 2, w.z - 0.03, 0, 0, 4)
      const c = new Vector3(0, s * 0.625, 0).applyMatrix4(M)
      const g = new CylinderGeometry(0.04, 0.04, 0.05, 12, 1)
      g.applyMatrix4(new Matrix4().compose(c, new Quaternion().setFromRotationMatrix(M), new Vector3(1, 1, 1)))
      parts.push(g)
    }
  }
  const nonIdx = parts.map((g) => metalUV(g, BRUSH_TILE, true)) // v16: metre-based UVs for the brushed texture set
  const m = mergeGeometries(nonIdx, false)!
  parts.forEach((g) => g.dispose())
  return m
}

/** moving-head housing: rounded can with cooling ribs; lens at −y */
function headGeometry() {
  const parts: BufferGeometry[] = []
  const body = new CylinderGeometry(0.105, 0.12, 0.24, 16, 1); parts.push(body)
  const cap = new SphereGeometry(0.105, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2); cap.translate(0, 0.12, 0); parts.push(cap)
  for (let k = 0; k < 4; k++) { const r = new TorusGeometry(0.116, 0.007, 4, 18); r.rotateX(Math.PI / 2); r.translate(0, 0.07 - k * 0.045, 0); parts.push(r) }
  const bezel = new TorusGeometry(0.1, 0.014, 6, 20); bezel.rotateX(Math.PI / 2); bezel.translate(0, -0.12, 0); parts.push(bezel)
  for (const s of [-1, 1]) { const hub = new CylinderGeometry(0.03, 0.03, 0.03, 10); hub.rotateZ(Math.PI / 2); hub.translate(s * 0.115, 0, 0); parts.push(hub) }
  const ni = parts.map((g) => (g.index ? g.toNonIndexed() : g))
  ni.forEach((g) => g.deleteAttribute('uv'))
  return mergeGeometries(ni, false)!
}

export const LightRig: React.FC<LightRigProps> = ({ position = [0, 4.2, 0], width = 7, beamLength = 7, tiltDir = 1, trussLength, spill = 18, spillDistance = 4.5 }) => {
  const root = useRef<Group>(null)
  const groups = useRef<(Group | null)[]>([])
  const lensMats = useRef<(MeshBasicMaterial | null)[]>([])
  const tubes = useRef<InstancedMesh>(null)
  const strobes = useRef<InstancedMesh>(null)
  const strobeLight = useRef<PointLight>(null)
  const trussMat = useMemo(() => brushedMetal('#2a2c30', 0.85, 0.25), [])
  const headMat = useRef<MeshStandardMaterial>(null)
  const beamEnv = useEnvelopes(HEADS)
  const tubeEnv = useEnvelopes(TUBES)
  const strobeEnv = useEnvelopes(STROBES)
  const tr = useTriggers()
  const aim = useRef(Array.from({ length: HEADS }, () => ({ z: 0, x: 0.35 })))
  const tl = trussLength ?? width + 1
  const staticGeo = useMemo(() => rigStaticGeometry(tl, width), [tl, width])
  const headGeo = useMemo(() => headGeometry(), [])
  const beamRad = 0.32 * beamLength / 7 + 0.08
  const beamMats = useMemo(() => Array.from({ length: HEADS }, () => new ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending, toneMapped: false,
    uniforms: { uI: { value: 0 }, uTime: { value: 0 }, uCol: { value: PALETTE.cold.clone() }, uNoise: { value: hazeNoise() } },
  })), [])
  const slots = useMemo(() => ({
    tube: Array.from({ length: TUBES }, (_, i) => allocHalo(`rig.tube${i}`)),
    strobe: Array.from({ length: STROBES }, (_, i) => allocHalo(`rig.strobe${i}`)),
    lens: Array.from({ length: HEADS }, (_, i) => allocHalo(`rig.lens${i}`)),
  }), [])
  useEffect(() => { envOn(trussMat, 0.9, false, true); envOn(headMat.current, 1.0) }, [trussMat])
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    const T = tr.current
    const t = performance.now() / 1000
    const tw = shaderClock().t // shader time: wrapped (float32-safe; seamless, tiling noise texture)
    decayAll(beamEnv.current, delta, 11)
    decayAll(tubeEnv.current, delta, TUBE_DECAY) // v19: same envelope as the wall tubes
    decayAll(strobeEnv.current, delta, 28) // strobe: ~25 ms to half → sharp pop
    const chaseOn = beat.riser > 0
    // --- triggers on new 16th steps ---
    if (beat.step !== T.step) {
      T.step = beat.step
      const s16 = beat.step % 16
      if (chaseOn) {
        // riser chase: one source per slot, rotating → per source ≤ 16th-rate / n
        const div = beat.riser > 0.6 ? 1 : 2
        if (beat.step % div === 0) {
          const slot = Math.floor(beat.step / div)
          fire(beamEnv.current, slot % HEADS, 0.6 + 0.4 * beat.riser)
          fire(tubeEnv.current, slot % TUBES, 0.6 + 0.4 * beat.riser)
          if (beat.riser > 0.8) fire(strobeEnv.current, slot % STROBES, 0.7)
        }
      } else if (groove > 0.5 && s16 % 4 === 2) {
        // offbeat: odd beams + random tubes slam
        for (let i = 1; i < HEADS; i += 2) fire(beamEnv.current, i, 0.85)
        for (let i = 0; i < TUBES; i++) if (hash2(beat.step, i + 17) < 0.45) fire(tubeEnv.current, i, 1)
      }
    }
    if (beat.kickN !== T.kickN) {
      T.kickN = beat.kickN
      if (groove > 0.5 && !chaseOn) for (let i = 0; i < HEADS; i += 2) fire(beamEnv.current, i, 1)
    }
    if (beat.clapN !== T.clapN) {
      T.clapN = beat.clapN
      // clap: tight strobe pop, alternating fixture pairs → each fixture ≤ ~1.2 Hz
      const pair = T.clapCount++ % 2
      for (let i = pair; i < STROBES; i += 2) fire(strobeEnv.current, i, 1)
    }
    // --- beams snap to new hard angles every half bar (+ stab kicks the angle) ---
    const half = Math.floor(beat.step / 8)
    if (half !== T.half) {
      T.half = half
      for (let i = 0; i < HEADS; i++) {
        const side = i % 2 ? 1 : -1
        aim.current[i].z = side * (0.05 + 0.55 * hash2(half, i + 3)) * (hash2(half, i + 9) < 0.3 ? -1 : 1)
        aim.current[i].x = 0.15 + 0.45 * hash2(half, i + 5)
      }
    }
    const drop = beat.dropFlash
    const on = beat.lit > 0.001
    for (let i = 0; i < HEADS; i++) {
      const g = groups.current[i]
      const mat = beamMats[i]
      const B = fx.beams[i]
      if (!g) continue
      const side = i % 2 ? 1 : -1
      // breaks: slow wide sweep instead of snaps
      const brkSweep = beat.breakAmt * Math.sin(beat.time * 0.3 + i * 1.7) * 0.4
      g.rotation.z = aim.current[i].z * groove + brkSweep * side + 0.15 * beat.stab * side
      g.rotation.x = tiltDir * (aim.current[i].x * groove + 0.35 * beat.breakAmt)
      const e = beamEnv.current.v[i]
      const v = Math.min(1, e * e + drop + 0.06 * beat.breakAmt + 0.08 * beat.stab)
      meter(`beam${i}`, v)
      const I = 0.9 * v * G
      mat.uniforms.uI.value = I
      mat.uniforms.uTime.value = tw + i * 7.3
      const lm = lensMats.current[i]
      if (lm) lm.color.copy(PALETTE.cold).multiplyScalar(0.02 * G + 1.3 * I)
      g.updateMatrixWorld()
      g.localToWorld(B.p.set(0, -0.14, 0))
      B.d.set(0, -1, 0).transformDirection(g.matrixWorld)
      B.len = beamLength
      B.rad = beamRad
      B.v = on ? I : 0
      setHalo(slots.lens[i], B.p, null, 0.3, 1.1 * I, PALETTE.cold.r, PALETTE.cold.g, PALETTE.cold.b)
    }
    const rg = root.current
    let glowMax = 0
    for (let i = 0; i < TUBES; i++) {
      const te = tubeEnv.current.v[i]
      const v = Math.min(1, te * te + drop)
      meter(`tube${i}`, v)
      // fluorescent character: faint 2-tone shimmer + rare tiny dips (never brighter than the hit)
      const fl = 1 - 0.035 * (0.5 + 0.5 * Math.sin(t * 43 + i * 2.3)) * (0.5 + 0.5 * Math.sin(t * 3.1 + i)) - (hash2(Math.floor(t * 12), i + 41) < 0.03 ? 0.18 : 0)
      const [r, gg, b] = TINTS[i % TINTS.length]
      const k = (TUBE_IDLE + v) * G * fl
      glowMax = Math.max(glowMax, v * G)
      if (tubes.current) tubes.current.setColorAt(i, tmpCol.setRGB(PALETTE.cold.r * r * k, PALETTE.cold.g * gg * k, PALETTE.cold.b * b * k))
      if (rg) {
        _m4.multiplyMatrices(rg.matrixWorld, tubeMatrices[i])
        _v.setFromMatrixPosition(_m4)
        _ax.set(0, 0.5, 0).applyMatrix4(_m4).sub(_v) // half the tube along its axis
        setHalo(slots.tube[i], _v.addScaledVector(_w.set(0, 0, 1).transformDirection(rg.matrixWorld), 0.03), _ax, TUBE_HALO_R, TUBE_HALO_I * k, r, gg, b)
      }
    }
    if (tubes.current?.instanceColor) tubes.current.instanceColor.needsUpdate = true
    let sMax = 0
    for (let i = 0; i < STROBES; i++) {
      const v = Math.min(1, strobeEnv.current.v[i] + drop)
      sMax = Math.max(sMax, v)
      meter(`strobe${i}`, v)
      const k = v * G
      if (strobes.current) strobes.current.setColorAt(i, tmpCol.copy(PALETTE.white).multiplyScalar(k))
      if (rg) {
        rg.localToWorld(_v.set(strobeX(i, width), 0.25, 0.18))
        _ax.set(0.16, 0, 0)
        setHalo(slots.strobe[i], _v, _ax, 0.3, 0.9 * k, 1, 1, 1)
      }
    }
    if (strobes.current?.instanceColor) strobes.current.instanceColor.needsUpdate = true
    fx.rigGlow = Math.max(glowMax, sMax * G)
    {
      let tb = 0
      for (let i = 0; i < TUBES; i++) tb = Math.max(tb, tubeEnv.current.v[i])
      let bm = 0
      for (let i = 0; i < HEADS; i++) bm = Math.max(bm, beamEnv.current.v[i])
      beat.whiteHit = Math.min(1, Math.max(sMax, 0.7 * tb, 0.6 * bm * bm) * G)
    }
    // tiny, short-range white spill from the strobes onto the truss/booth only (no room fill)
    if (strobeLight.current) strobeLight.current.intensity = spill * sMax * G
  })
  const tubeMatrices = useMemo(() => Array.from({ length: TUBES }, (_, i) => rigTubeMatrix(i, width)), [width])
  const strobeMatrices = useMemo(() => Array.from({ length: STROBES }, (_, i) => new Matrix4().makeRotationZ((hash2(i, 508) - 0.5) * 0.06).setPosition(strobeX(i, width), 0.25, 0.175)), [width])
  return (
    <group position={position} rotation={[0, 0.012, 0.007]} ref={root}>
      {/* box truss, moving-head bases / yokes, strobe housings, tube hangers (one merged mesh) */}
      <mesh geometry={staticGeo} material={trussMat} />
      {/* strobe panels (instanced) */}
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) { strobeMatrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }) } (strobes as React.MutableRefObject<InstancedMesh | null>).current = m }}
        args={[undefined, undefined, STROBES]} frustumCulled={false}>
        <planeGeometry args={[0.36, 0.11]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {/* fluorescent tubes hanging in front of the truss (instanced, per-tube colour temperature) */}
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) { tubeMatrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }) } (tubes as React.MutableRefObject<InstancedMesh | null>).current = m }}
        args={[tubeGeometry(), tubeMaterial(), TUBES]} frustumCulled={false} />
      {Array.from({ length: HEADS }, (_, i) => (
        <group key={i} position={[headX(i, width), -0.4, 0]} ref={(g) => { groups.current[i] = g }}>
          <mesh geometry={headGeo}>
            <meshStandardMaterial ref={i === 0 ? headMat : undefined} color="#141518" metalness={0.6} roughness={0.38} />
          </mesh>
          <mesh position={[0, -0.122, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.09, 20]} />
            <meshBasicMaterial ref={(m) => { lensMats.current[i] = m }} color="#000000" toneMapped={false} />
          </mesh>
          {/* soft volumetric beam (cone, apex at the lens) */}
          <mesh position={[0, -beamLength / 2 - 0.12, 0]} material={beamMats[i]} renderOrder={5}>
            <coneGeometry args={[beamRad, beamLength, 28, 1, true]} />
          </mesh>
        </group>
      ))}
      <pointLight ref={strobeLight} position={[0, -0.5, 0.9]} color={PALETTE.white} distance={spillDistance} decay={2} intensity={0} />
    </group>
  )
}

// ---------------------------------------------------------------- back wall: hand-installed fluorescent tubes (low-res equalizer)
export interface TubeWallProps {
  /** wall-local origin: x = 0 centre, y = 0 floor, z = 0 just in front of the wall face (face at z = −0.08) */
  position?: [number, number, number]
  /** ceiling height (conduit runs up to it) */
  ceilY?: number
  /** soft haze glow on the wall behind the tubes (silhouettes the crowd); kept faint and capped */
  haze?: boolean
}
const WALL_Z = -0.08
const WALL_TC = 0.03
/** (v19) kick: the two tubes nearest the centre; offbeat highs: band by distance from the centre; chases: mirrored groups by |x| */
const WALL_KICK = (() => { const o = WALL_TUBES.map((t, i) => [Math.abs(t.x), i] as const).sort((a, b) => a[0] - b[0]); return [o[0][1], o[1][1]] })()
const WALL_MAXX = Math.max(...WALL_TUBES.map((t) => Math.abs(t.x)))
const WALL_BAND = WALL_TUBES.map((t) => Math.min(15, 1 + Math.floor((Math.abs(t.x) / WALL_MAXX) * 6.5)))
const WALL_GROUP = WALL_TUBES.map((t) => Math.min(3, Math.floor((Math.abs(t.x) / (WALL_MAXX + 0.01)) * 4)))

/** irregular tube wall (see tubes.ts): hard-gated spectrum, kick slams the centre pair, drops slam all */
export const TubeWall: React.FC<TubeWallProps> = ({ position = [0, 0, 0], ceilY = 3.1, haze = false }) => {
  const root = useRef<Group>(null)
  const hazeMat = useRef<MeshBasicMaterial>(null)
  const hazeTex = useMemo(() => radialTexture(), [])
  const n = WALL_TUBES.length
  const tubes = useRef<InstancedMesh | null>(null)
  const glow = useRef<Mesh>(null)
  const env = useEnvelopes(n)
  const tr = useTriggers()
  const slots = useMemo(() => Array.from({ length: n }, (_, i) => allocHalo(`wall.tube${i}`)), [n])
  const matrices = useMemo(() => WALL_TUBES.map((t) => wallTubeMatrix(t, WALL_TC)), [])
  const fixtures = useMemo(() => wallFixtures(WALL_TUBES, WALL_Z, WALL_TC, ceilY - position[1]), [ceilY, position[1]])
  const fixMat = useMemo(() => brushedMetal('#2a2c30', 0.85, 0.25), [])
  const cableMat = useMemo(() => new MeshStandardMaterial({ color: '#0d0d0e', roughness: 0.55, metalness: 0.1 }), [])
  useEffect(() => { envOn(fixMat, 0.9, false, true) }, [fixMat])
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    const T = tr.current
    const t = performance.now() / 1000
    decayAll(env.current, delta, TUBE_DECAY)
    if (beat.kickN !== T.kickN) {
      T.kickN = beat.kickN
      if (groove > 0.5 && !(beat.riser > 0)) for (const i of WALL_KICK) fire(env.current, i, 1)
    }
    if (beat.step !== T.step) {
      T.step = beat.step
      if (beat.riser > 0) {
        // aggressive outward chase (mirrored groups by distance from the centre), one group per 16th late in the build
        const div = beat.riser > 0.6 ? 1 : 2
        if (beat.step % div === 0) {
          const g = Math.floor(beat.step / div) % 4
          for (let i = 0; i < n; i++) if (WALL_GROUP[i] === g) fire(env.current, i, 1)
        }
      } else if (groove > 0.5 && beat.step % 4 === 2) {
        // offbeat: outer tubes hit only when there is energy in their band → hard gate, no soft fill
        for (let i = 0; i < n; i++) if ((beat.levels[WALL_BAND[i]] ?? 0) > 0.45 && !WALL_KICK.includes(i)) fire(env.current, i, 0.9)
      }
    }
    let mxV = 0
    const rg = root.current
    for (let i = 0; i < n; i++) {
      const e = env.current.v[i]
      const v = Math.min(1, e * e + beat.dropFlash + 0.05 * beat.breakAmt)
      meter(`wall${i}`, v)
      const fl = 1 - 0.035 * (0.5 + 0.5 * Math.sin(t * 41 + i * 1.9)) * (0.5 + 0.5 * Math.sin(t * 2.7 + i * 0.7)) - (hash2(Math.floor(t * 11), i + 77) < 0.025 ? 0.15 : 0)
      const [r, g, b] = TINTS[(i * 3 + 1) % TINTS.length]
      const k = (TUBE_IDLE + v) * G * fl
      mxV = Math.max(mxV, v * G)
      tubes.current?.setColorAt(i, tmpCol.setRGB(PALETTE.cold.r * r * k, PALETTE.cold.g * g * k, PALETTE.cold.b * b * k))
      if (rg) {
        const W = WALL_TUBES[i]
        const d = tubeDir(W)
        rg.localToWorld(_v.set(W.x, W.y, WALL_TC + 0.03))
        rg.localToWorld(_w.set(W.x + d.x * W.len / 2, W.y + d.y * W.len / 2, WALL_TC + 0.03))
        _ax.subVectors(_w, _v)
        setHalo(slots[i], _v, _ax, TUBE_HALO_R, TUBE_HALO_I * k, r, g, b)
      }
    }
    if (tubes.current?.instanceColor) tubes.current.instanceColor.needsUpdate = true
    fx.wallGlow = mxV
    // haze glow on the wall: follows the brightest tube, capped low (v19: weaker, so the tubes read as lamps, not a glow)
    if (hazeMat.current) {
      let mx = 0
      for (let i = 0; i < n; i++) mx = Math.max(mx, env.current.v[i])
      hazeMat.current.opacity = G * Math.min(0.1, 0.015 * (1 - beat.breakAmt) + 0.08 * mx * mx + 0.06 * beat.dropFlash + 0.01 * beat.breakAmt)
    }
    // thin deep-red line at the foot of the wall: kick ambience
    if (glow.current) {
      const k = beat.kickHit * beat.kickHit
      tmpCol.copy(PALETTE.red).multiplyScalar(G * Math.min(1, groove * k + 0.1 * beat.breakAmt + beat.dropFlash))
      ;(glow.current.material as MeshBasicMaterial).color.copy(tmpCol)
    }
  })
  return (
    <group position={position} ref={root}>
      {haze && (
        <mesh position={[0, 1.55, 0.06]}>
          <planeGeometry args={[10.5, 3.2]} />
          <meshBasicMaterial ref={hazeMat} color={PALETTE.cold} alphaMap={hazeTex} transparent opacity={0} blending={AdditiveBlending}
            depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) matrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }); tubes.current = m }}
        args={[tubeGeometry(), tubeMaterial(), n]} frustumCulled={false} />
      {/* lampholders / end caps, clips, conduit (one merged mesh) + loose feed cables */}
      <mesh geometry={fixtures.metal} material={fixMat} />
      <mesh geometry={fixtures.rubber} material={cableMat} />
      <mesh ref={glow} position={[0.15, 0.25, 0.0]} rotation={[0, 0, 0.004]}>
        <boxGeometry args={[8.2, 0.03, 0.03]} />
        <meshBasicMaterial color="#000000" toneMapped={false} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------- fog
/** distance fog on the scene (restored on unmount) */
export const SceneFog: React.FC<{ color: string; near: number; far: number }> = ({ color, near, far }) => {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const prev = scene.fog
    scene.fog = new Fog(color, near, far)
    return () => {
      scene.fog = prev
    }
  }, [scene, color, near, far])
  return null
}

// ---------------------------------------------------------------- background
/** solid scene background (restored on unmount) */
export const SceneBackground: React.FC<{ color: string }> = ({ color }) => {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__gl = gl // perf probes (draw calls / triangles)
  }, [gl])
  useEffect(() => {
    const prev = scene.background
    scene.background = new Color(color)
    return () => {
      scene.background = prev
    }
  }, [scene, color])
  return null
}
