import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending, BoxGeometry, type BufferGeometry, Color, CylinderGeometry, Euler, Fog, Group, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, PointLight, Quaternion, SpotLight, Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { allocHalo, envOn, fx, setHalo, TINTS } from './fx'
import { beat } from '../../techno/beat'
import { BRUSH_TILE, concreteTexture, radialTexture } from './textures'
import { metalUV } from './geo'
import { CEIL_TUBES, ceilFixtures, ceilTubeMatrix, SIDE_FEED_PAIRS, SIDE_TUBES, type SideTube, TUBE_DECAY, TUBE_HALO_I, TUBE_HALO_R, TUBE_IDLE, tubeDir, tubeGeometry, tubeMaterial, WALL_TUBES, wallFixtures, wallTubeMatrix } from './tubes'
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
  return useRef({ step: -1, kickN: 0, clapN: 0, half: -1, clapCount: 0, stabOn: false })
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

// ---------------------------------------------------------------- truss: hanging fluorescent tubes + strobe fixtures
export interface LightRigProps {
  position?: [number, number, number]
  width?: number
  /** truss length override (defaults to width + 1) */
  trussLength?: number
  /** strobe spill light peak / range (small rooms: lower, so the ceiling doesn't flash) */
  spill?: number
  spillDistance?: number
}

const STROBES = 4

const _v = new Vector3()
const _w = new Vector3()
const _ax = new Vector3()
const _m4 = new Matrix4()

/**
 * v21: the truss carries only fluorescent tubes (same tube / fixture look as the back wall) — the moving heads are gone.
 * Front row: tubes hung in front of the truss, roughly parallel to it. Low row (where the heads were): tubes hung under
 * the truss on two wires each, hand-rigged — mixed lengths, one end hanging lower, twisted a little in plan.
 * Rig-local: x along the truss, y up (0 = truss centre), z towards the booth. Wires stay inside the truss (|z| ≤ 0.15).
 */
interface RigTube { x: number; y: number; z: number; len: number; rz: number; ry: number; low: boolean }
const FRONT = 5
const rigTubes = (width: number): RigTube[] => {
  const front = Array.from({ length: FRONT }, (_, i) => ({
    x: (i - (FRONT - 1) / 2) * ((width + 0.4) / FRONT) + (hash2(i, 503) - 0.5) * 0.12,
    y: -0.2 - hash2(i, 504) * 0.05, z: 0.25 + (hash2(i, 505) - 0.5) * 0.03, len: 1.2,
    rz: (hash2(i, 506) - 0.5) * 0.05, ry: (hash2(i, 507) - 0.5) * 0.06, low: false,
  }))
  // x (fraction of the half width), y, len, hang angle rz, plan twist ry — authored, plus a small seeded jitter
  const LOW: [number, number, number, number, number][] = [
    [-0.93, -0.46, 1.5, 0.035, 0.24],
    [-0.31, -0.44, 1.2, 0.15, -0.05],
    [0.37, -0.44, 1.5, -0.03, -0.13],
    [0.87, -0.46, 1.2, -0.09, 0.33],
  ]
  const low = LOW.map(([fx, y, len, rz, ry], i) => ({
    x: (fx * width) / 2 + (hash2(i, 511) - 0.5) * 0.08, y: y + (hash2(i, 512) - 0.5) * 0.03, z: -0.02 + (hash2(i, 513) - 0.5) * 0.04,
    len, rz: rz + (hash2(i, 514) - 0.5) * 0.02, ry: ry + (hash2(i, 515) - 0.5) * 0.04, low: true,
  }))
  return [...front, ...low]
}
/** unit cylinder (axis y) → this tube: lying along the truss (x), hang angle rz, plan twist ry */
const rigTubeMatrix = (t: RigTube, len = t.len) =>
  new Matrix4().compose(new Vector3(t.x, t.y, t.z), new Quaternion().setFromEuler(new Euler(0, t.ry, Math.PI / 2 + t.rz)), new Vector3(1, len, 1))
const strobeX = (i: number, width: number) => (i - (STROBES - 1) / 2) * ((width + 0.6) / (STROBES - 1)) + (hash2(i, 502) - 0.5) * 0.12

/** static truss + strobe housings + tube hangers / end caps → one merged geometry (one draw) */
function rigStaticGeometry(trussLen: number, width: number, tubes: RigTube[]) {
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
  // strobe housings on top of the truss (each clamped at its own slight angle)
  for (let i = 0; i < STROBES; i++) {
    const x = strobeX(i, width), a = (hash2(i, 508) - 0.5) * 0.06
    box(0.44, 0.17, 0.1, x, H + 0.1, 0.12, a)
    box(0.36, 0.02, 0.04, x, H + 0.2, 0.12, a)
    box(0.05, 0.05, 0.12, x - 0.17, H + 0.03, 0.12)
    box(0.05, 0.05, 0.12, x + 0.17, H + 0.03, 0.12)
  }
  // tube holders: two hanging wires up to the truss's lower chord + end caps (same as the wall tubes), following each tube's hang
  for (const t of tubes) {
    const M = rigTubeMatrix(t, 1)
    const a = t.len / 2 - (t.len > 1.3 ? 0.2 : 0.15)
    for (const s of [-1, 1]) {
      const w = new Vector3(0, s * a, 0).applyMatrix4(M)
      const wz = t.low ? w.z : w.z - 0.03
      const top = t.low ? -H + 0.005 : -H + 0.02, len = top - w.y
      cyl(0.004, len, w.x, w.y + len / 2, wz, 0, 0, 4)
      if (t.low) box(0.03, 0.02, 0.03, w.x, -H - 0.01, wz) // wire clamp on the bottom lacing
      const c = new Vector3(0, s * (t.len / 2 + 0.025), 0).applyMatrix4(M)
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

export const LightRig: React.FC<LightRigProps> = ({ position = [0, 4.2, 0], width = 7, trussLength, spill = 18, spillDistance = 4.5 }) => {
  const root = useRef<Group>(null)
  const tubes = useRef<InstancedMesh>(null)
  const strobes = useRef<InstancedMesh>(null)
  const strobeLight = useRef<PointLight>(null)
  const trussMat = useMemo(() => brushedMetal('#2a2c30', 0.85, 0.25), [])
  const list = useMemo(() => rigTubes(width), [width])
  const lowIdx = useMemo(() => list.flatMap((t, i) => (t.low ? [i] : [])), [list])
  const n = list.length
  const tubeEnv = useEnvelopes(n)
  const strobeEnv = useEnvelopes(STROBES)
  const tr = useTriggers()
  const tl = trussLength ?? width + 1
  const staticGeo = useMemo(() => rigStaticGeometry(tl, width, list), [tl, width, list])
  const slots = useMemo(() => ({
    tube: Array.from({ length: n }, (_, i) => allocHalo(`rig.tube${i}`)),
    strobe: Array.from({ length: STROBES }, (_, i) => allocHalo(`rig.strobe${i}`)),
  }), [n])
  useEffect(() => { envOn(trussMat, 0.9, false, true) }, [trussMat])
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    const T = tr.current
    const t = performance.now() / 1000
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
          fire(tubeEnv.current, slot % FRONT, 0.6 + 0.4 * beat.riser)
          fire(tubeEnv.current, lowIdx[slot % lowIdx.length], 0.6 + 0.4 * beat.riser)
          if (beat.riser > 0.8) fire(strobeEnv.current, slot % STROBES, 0.7)
        }
      } else if (groove > 0.5 && s16 % 4 === 2) {
        // offbeat: every other low tube + random front tubes slam
        for (let k = 1; k < lowIdx.length; k += 2) fire(tubeEnv.current, lowIdx[k], 0.85)
        for (let i = 0; i < FRONT; i++) if (hash2(beat.step, i + 17) < 0.45) fire(tubeEnv.current, i, 1)
      }
    }
    if (beat.kickN !== T.kickN) {
      T.kickN = beat.kickN
      // kick: the other low tubes
      if (groove > 0.5 && !chaseOn) for (let k = 0; k < lowIdx.length; k += 2) fire(tubeEnv.current, lowIdx[k], 1)
    }
    if (beat.clapN !== T.clapN) {
      T.clapN = beat.clapN
      // clap: tight strobe pop, alternating fixture pairs → each fixture ≤ ~1.2 Hz
      const pair = T.clapCount++ % 2
      for (let i = pair; i < STROBES; i += 2) fire(strobeEnv.current, i, 1)
    }
    const drop = beat.dropFlash
    const rg = root.current
    let glowMax = 0
    let tb = 0
    for (let i = 0; i < n; i++) {
      const te = tubeEnv.current.v[i]
      tb = Math.max(tb, te)
      // low row: a faint glow in breaks and a nudge on stabs (what the heads used to do)
      const v = Math.min(1, te * te + drop + (list[i].low ? 0.06 * beat.breakAmt + 0.08 * beat.stab : 0))
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
    beat.whiteHit = Math.min(1, Math.max(sMax, 0.7 * tb) * G)
    // tiny, short-range white spill from the strobes onto the truss/booth only (no room fill)
    if (strobeLight.current) strobeLight.current.intensity = spill * sMax * G
  })
  const tubeMatrices = useMemo(() => list.map((t) => rigTubeMatrix(t)), [list])
  const strobeMatrices = useMemo(() => Array.from({ length: STROBES }, (_, i) => new Matrix4().makeRotationZ((hash2(i, 508) - 0.5) * 0.06).setPosition(strobeX(i, width), 0.25, 0.175)), [width])
  return (
    <group position={position} rotation={[0, 0.012, 0.007]} ref={root}>
      {/* box truss, strobe housings, tube hangers / end caps (one merged mesh) */}
      <mesh geometry={staticGeo} material={trussMat} />
      {/* strobe panels (instanced) */}
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) { strobeMatrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }) } (strobes as React.MutableRefObject<InstancedMesh | null>).current = m }}
        args={[undefined, undefined, STROBES]} frustumCulled={false}>
        <planeGeometry args={[0.36, 0.11]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {/* fluorescent tubes hanging in front of / under the truss (instanced, per-tube colour temperature) */}
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) { tubeMatrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }) } (tubes as React.MutableRefObject<InstancedMesh | null>).current = m }}
        args={[tubeGeometry(), tubeMaterial(), n]} frustumCulled={false} />
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
/** outer half of the wall (|x| > 1.8) and the outermost tube on each side */
const WALL_OUTER = WALL_TUBES.flatMap((t, i) => (Math.abs(t.x) > 1.8 ? [i] : []))
const WALL_EDGE = [WALL_TUBES.reduce((a, t, i) => (t.x < WALL_TUBES[a].x ? i : a), 0), WALL_TUBES.reduce((a, t, i) => (t.x > WALL_TUBES[a].x ? i : a), 0)]

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
      if (groove > 0.5 && !(beat.riser > 0)) {
        for (const i of WALL_KICK) fire(env.current, i, 1)
        // v23a: + one random outer tube per kick (the edges of the wall hit too, never the same pattern twice)
        const o = WALL_OUTER[Math.floor(hash2(beat.kickN, 211) * WALL_OUTER.length)]
        fire(env.current, o, 0.85)
      }
    }
    if (beat.clapN !== T.clapN) {
      T.clapN = beat.clapN
      // v23a: clap → the outermost tube on one side (alternating), so the corners slam with the strobes
      if (groove > 0.5 && !(beat.riser > 0)) fire(env.current, WALL_EDGE[T.clapCount++ % 2], 1)
    }
    if (beat.stab > 0.5 && !T.stabOn) { for (let i = 0; i < n; i++) if (hash2(beat.step, i + 233) < 0.25) fire(env.current, i, 0.8) }
    T.stabOn = beat.stab > 0.5
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
        // v23a: band energy raises the odds instead of a hard gate → the outer tubes actually hit in the groove
        for (let i = 0; i < n; i++) {
          if (WALL_KICK.includes(i)) continue
          const lv = beat.levels[WALL_BAND[i]] ?? 0
          if (lv > 0.45 || hash2(beat.step, i + 221) < 0.2 + 0.4 * lv) fire(env.current, i, 0.8 + 0.2 * Math.min(1, lv))
        }
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

// ---------------------------------------------------------------- booth front: ceiling tubes that light the people facing the DJ
/** tube level on a hit (dark between hits: no constant glow) */
const FRONT_HIT = 0.85
/** spot intensity (cd) when a group is fully lit; the spots only exist for the hits */
const FRONT_LIGHT = 13
/** halo for these tubes: tight and dimmer than the rig's, so the glow stays on the glass and doesn't read as a lit ceiling */
const FRONT_HALO_R = 0.1
const FRONT_HALO_I = 0.45 * TUBE_HALO_I
/** spot cone: half-angle + aim keep the top edge well below horizontal → nothing reaches the ceiling */
const FRONT_SPOT_ANGLE = 0.8
const FRONT_SPOTS: { pos: [number, number, number]; aim: [number, number, number]; group: (z: number) => boolean }[] = [
  // booth-side spot aims forward/down at the faces of people at z ≈ 1.5–3; second one covers the ones further back
  { pos: [-0.4, -0.3, 0.9], aim: [-0.4, 0, 2.6], group: (z) => z < 2.2 },
  { pos: [0.4, -0.3, 2.6], aim: [0.4, 0, 4.3], group: (z) => z >= 2.2 },
]

/**
 * v22a: five hand-hung tubes above the floor in front of the booth (see CEIL_TUBES) + two downward spot lights.
 * Dark between hits: they only fire on offbeat hits, the build-up chase and the drop flash (blackout before drops).
 * The spots point down/forward (cone edge < 80° from vertical) so people / floor in front of the booth get lit and the
 * ceiling doesn't. The fluorescent shimmer + the "tired" tube's stutter are multiplicative → only visible during a hit.
 */
export const BoothFrontTubes: React.FC<{ ceilY: number }> = ({ ceilY }) => {
  const n = CEIL_TUBES.length
  const tubes = useRef<InstancedMesh | null>(null)
  const lights = useRef<(SpotLight | null)[]>([])
  const env = useEnvelopes(n)
  const tr = useTriggers()
  const slots = useMemo(() => Array.from({ length: n }, (_, i) => allocHalo(`front.tube${i}`)), [n])
  const matrices = useMemo(() => CEIL_TUBES.map((t) => ceilTubeMatrix(t, ceilY)), [ceilY])
  const fixtures = useMemo(() => ceilFixtures(CEIL_TUBES, ceilY), [ceilY])
  const fixMat = useMemo(() => brushedMetal('#2a2c30', 0.85, 0.25), [])
  const cableMat = useMemo(() => new MeshStandardMaterial({ color: '#0d0d0e', roughness: 0.55, metalness: 0.1 }), [])
  const targets = useMemo(() => FRONT_SPOTS.map((S) => { const o = new Object3D(); o.position.set(...S.aim); return o }), [])
  const groupN = useMemo(() => FRONT_SPOTS.map((S) => CEIL_TUBES.filter((t) => S.group(t.z)).length), [])
  useEffect(() => { envOn(fixMat, 0.9, false, true) }, [fixMat])
  useFrame((_, delta) => {
    const G = gate()
    const T = tr.current
    const t = performance.now() / 1000
    decayAll(env.current, delta, TUBE_DECAY)
    if (beat.step !== T.step) {
      T.step = beat.step
      if (beat.riser > 0) {
        const div = beat.riser > 0.6 ? 2 : 4
        if (beat.step % div === 0) fire(env.current, Math.floor(beat.step / div) % n, 0.5 + 0.5 * beat.riser)
      } else if (beat.breakAmt < 0.5 && beat.step % 4 === 2) {
        for (let i = 0; i < n; i++) if (hash2(beat.step, i + 61) < 0.35) fire(env.current, i, 0.8)
      }
    }
    const sums = [0, 0]
    for (let i = 0; i < n; i++) {
      const e = env.current.v[i]
      const v = Math.min(1, FRONT_HIT * e * e + 0.7 * beat.dropFlash)
      meter(`front${i}`, v)
      // shimmer + rare stutter (tube 4 is a tired one); multiplicative, so nothing shows between hits
      const tired = i === 4 ? 0.12 : 0.02
      const fl = 1 - 0.04 * (0.5 + 0.5 * Math.sin(t * 47 + i * 1.3)) * (0.5 + 0.5 * Math.sin(t * 2.3 + i)) - (hash2(Math.floor(t * 13), i + 91) < tired ? 0.45 : 0)
      const [r, g, b] = TINTS[(i * 2 + 2) % TINTS.length]
      const k = v * G * fl
      sums[FRONT_SPOTS[0].group(CEIL_TUBES[i].z) ? 0 : 1] += k
      tubes.current?.setColorAt(i, tmpCol.setRGB(PALETTE.cold.r * r * k, PALETTE.cold.g * g * k, PALETTE.cold.b * b * k))
      _v.setFromMatrixPosition(matrices[i])
      _ax.set(0, 0.5, 0).applyMatrix4(matrices[i]).sub(_v) // half the tube along its axis
      _v.y -= 0.02
      setHalo(slots[i], _v, _ax, FRONT_HALO_R, FRONT_HALO_I * k, r, g, b)
    }
    if (tubes.current?.instanceColor) tubes.current.instanceColor.needsUpdate = true
    lights.current.forEach((L, j) => { if (L) L.intensity = (FRONT_LIGHT * Math.min(1, (2 * sums[j]) / groupN[j])) })
  })
  return (
    <group>
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) matrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }); tubes.current = m }}
        args={[tubeGeometry(), tubeMaterial(), n]} frustumCulled={false} />
      <mesh geometry={fixtures.metal} material={fixMat} />
      <mesh geometry={fixtures.rubber} material={cableMat} />
      {FRONT_SPOTS.map((S, j) => (
        <group key={j}>
          <primitive object={targets[j]} />
          <spotLight ref={(l) => { lights.current[j] = l }} position={[S.pos[0], ceilY + S.pos[1], S.pos[2]]} target={targets[j]}
            color={PALETTE.cold} angle={FRONT_SPOT_ANGLE} penumbra={0.75} distance={6} decay={2} intensity={0} />
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------- side walls: tubes + downward spots (v23a)
/** side tubes hit a bit below the front (the truss / booth front stay the most prominent) */
const SIDE_HIT = 0.85
/** spot peak (cd) per side spot; front spots peak at FRONT_LIGHT */
const SIDE_LIGHT = 9
const SIDE_SPOT_ANGLE = 0.75
/** 2 spots per side, near the wall under the ceiling, aimed down / inward at the side floor (cone top edge ≈ 80° from vertical) */
const SIDE_SPOTS: { side: 'L' | 'R'; z: number }[] = [{ side: 'L', z: -3.0 }, { side: 'L', z: 1.8 }, { side: 'R', z: -2.2 }, { side: 'R', z: 2.8 }]
const SIDE_LIST: SideTube[] = [...SIDE_TUBES.L, ...SIDE_TUBES.R]
/** chase order: back → front along each wall, both walls together (mirrored sweep) */
const SIDE_SWEEP = (() => {
  const by = (L: SideTube[], off: number) => L.map((t, i) => [t.z, i + off] as const).sort((a, b) => a[0] - b[0]).map((q) => q[1])
  const l = by(SIDE_TUBES.L, 0), r = by(SIDE_TUBES.R, SIDE_TUBES.L.length)
  return Array.from({ length: Math.max(l.length, r.length) }, (_, k) => [l[Math.min(k, l.length - 1)], r[Math.min(k, r.length - 1)]])
})()

/**
 * Hand-mounted tubes on both side walls + four downward spots that throw real light onto the side floor / crowd /
 * wall. Same envelopes / gate as the rest: dark between hits, kick + offbeat + clap + stab hits picked per tube
 * (seeded, never a uniform pattern), mirrored back→front sweep in builds, everything slams on the drop.
 */
export const SideTubes: React.FC<{ width: number; ceilY: number }> = ({ width, ceilY }) => {
  const n = SIDE_LIST.length
  const nl = SIDE_TUBES.L.length
  const tubes = useRef<InstancedMesh | null>(null)
  const lights = useRef<(SpotLight | null)[]>([])
  const env = useEnvelopes(n)
  const tr = useTriggers()
  const slots = useMemo(() => Array.from({ length: n }, (_, i) => allocHalo(`side.tube${i}`)), [n])
  // wall frames: left wall rotated +90° (local +z → +x into the room), right wall −90°
  const frames = useMemo(() => ({
    L: new Matrix4().compose(new Vector3(-width / 2 + 0.08, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), new Vector3(1, 1, 1)),
    R: new Matrix4().compose(new Vector3(width / 2 - 0.08, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2), new Vector3(1, 1, 1)),
  }), [width])
  const matrices = useMemo(() => SIDE_LIST.map((t) => frames[t.side < 0 ? 'L' : 'R'].clone().multiply(wallTubeMatrix(t, WALL_TC))), [frames])
  const fixtures = useMemo(() => {
    const f = (['L', 'R'] as const).map((k, j) => { const g = wallFixtures(SIDE_TUBES[k], WALL_Z, WALL_TC, ceilY, SIDE_FEED_PAIRS[k], 40 + j * 20); g.metal.applyMatrix4(frames[k]); g.rubber.applyMatrix4(frames[k]); return g })
    return { metal: mergeGeometries([f[0].metal, f[1].metal], false)!, rubber: mergeGeometries([f[0].rubber, f[1].rubber], false)! }
  }, [frames, ceilY])
  const fixMat = useMemo(() => brushedMetal('#2a2c30', 0.85, 0.25), [])
  const cableMat = useMemo(() => new MeshStandardMaterial({ color: '#0d0d0e', roughness: 0.55, metalness: 0.1 }), [])
  const spots = useMemo(() => SIDE_SPOTS.map((S) => {
    const sx = S.side === 'L' ? -1 : 1
    const target = new Object3D(); target.position.set(sx * (width / 2 - 2.3), 0, S.z + 0.3)
    const near = SIDE_LIST.flatMap((t, i) => (t.side === sx && Math.abs(t.z - S.z) < 2.4 ? [i] : []))
    return { pos: [sx * (width / 2 - 0.35), ceilY - 0.4, S.z] as [number, number, number], target, near }
  }), [width, ceilY])
  useEffect(() => { envOn(fixMat, 0.9, false, true) }, [fixMat])
  const lvlBuf = useMemo(() => new Float32Array(n), [n])
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    const T = tr.current
    const t = performance.now() / 1000
    const E = env.current
    decayAll(E, delta, TUBE_DECAY)
    const chaseOn = beat.riser > 0
    if (beat.kickN !== T.kickN) {
      T.kickN = beat.kickN
      // kick: one tube on each wall (seeded pick per kick), so both sides thump with the floor
      if (groove > 0.5 && !chaseOn) {
        fire(E, Math.floor(hash2(beat.kickN, 301) * nl), SIDE_HIT)
        fire(E, nl + Math.floor(hash2(beat.kickN, 302) * (n - nl)), SIDE_HIT)
      }
    }
    if (beat.step !== T.step) {
      T.step = beat.step
      if (chaseOn) {
        const div = beat.riser > 0.6 ? 1 : 2
        if (beat.step % div === 0) for (const i of SIDE_SWEEP[Math.floor(beat.step / div) % SIDE_SWEEP.length]) fire(E, i, (0.6 + 0.4 * beat.riser) * SIDE_HIT)
      } else if (groove > 0.5 && beat.step % 4 === 2) {
        // offbeat: random tubes, more of them when the hats are loud
        const hats = beat.levels[12] ?? 0
        for (let i = 0; i < n; i++) if (hash2(beat.step, i + 311) < 0.22 + 0.28 * hats) fire(E, i, SIDE_HIT * (0.85 + 0.15 * hash2(beat.step, i + 312)))
      }
    }
    if (beat.clapN !== T.clapN) {
      T.clapN = beat.clapN
      // clap: one whole wall at a time (alternating) — the side "slap" that answers the truss strobes
      if (groove > 0.5 && !chaseOn) {
        const side = T.clapCount++ % 2
        for (let i = 0; i < n; i++) if ((i < nl ? 0 : 1) === side && hash2(beat.clapN, i + 321) < 0.7) fire(E, i, SIDE_HIT)
      }
    }
    if (beat.stab > 0.5 && !T.stabOn) for (let i = 0; i < n; i++) if (hash2(beat.step, i + 331) < 0.3) fire(E, i, 0.75 * SIDE_HIT)
    T.stabOn = beat.stab > 0.5
    const lvl = lvlBuf
    for (let i = 0; i < n; i++) {
      const e = E.v[i]
      const v = Math.min(1, e * e + SIDE_HIT * beat.dropFlash)
      meter(`side${i}`, v)
      const fl = 1 - 0.035 * (0.5 + 0.5 * Math.sin(t * 39 + i * 2.1)) * (0.5 + 0.5 * Math.sin(t * 2.9 + i * 0.6)) - (hash2(Math.floor(t * 12), i + 341) < 0.025 ? 0.2 : 0)
      const [r, g, b] = TINTS[(i * 5 + 3) % TINTS.length]
      const k = (TUBE_IDLE + v) * G * fl
      lvl[i] = v * G * fl
      tubes.current?.setColorAt(i, tmpCol.setRGB(PALETTE.cold.r * r * k, PALETTE.cold.g * g * k, PALETTE.cold.b * b * k))
      _v.setFromMatrixPosition(matrices[i])
      _ax.set(0, 0.5, 0).applyMatrix4(matrices[i]).sub(_v)
      _v.x += SIDE_LIST[i].side < 0 ? 0.03 : -0.03
      setHalo(slots[i], _v, _ax, TUBE_HALO_R, TUBE_HALO_I * k, r, g, b)
    }
    if (tubes.current?.instanceColor) tubes.current.instanceColor.needsUpdate = true
    // spots follow the brightest nearby tube (+ a bit of the second) → real light pops with the glass
    spots.forEach((S, j) => {
      let a = 0, b2 = 0
      for (const i of S.near) { const x = lvl[i]; if (x > a) { b2 = a; a = x } else if (x > b2) b2 = x }
      const L = lights.current[j]
      if (L) L.intensity = SIDE_LIGHT * Math.min(1, a + 0.35 * b2)
    })
  })
  return (
    <group>
      <instancedMesh ref={(m) => { if (m && !m.instanceColor) matrices.forEach((M, i) => { m.setMatrixAt(i, M); m.setColorAt(i, tmpCol.set(0, 0, 0)) }); tubes.current = m }}
        args={[tubeGeometry(), tubeMaterial(), n]} frustumCulled={false} />
      <mesh geometry={fixtures.metal} material={fixMat} />
      <mesh geometry={fixtures.rubber} material={cableMat} />
      {spots.map((S, j) => (
        <group key={j}>
          <primitive object={S.target} />
          <spotLight ref={(l) => { lights.current[j] = l }} position={S.pos} target={S.target}
            color={PALETTE.cold} angle={SIDE_SPOT_ANGLE} penumbra={0.7} distance={6} decay={2} intensity={0} />
        </group>
      ))}
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
