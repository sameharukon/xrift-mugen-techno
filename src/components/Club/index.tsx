import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, Color, DoubleSide, Fog, Group, Mesh, MeshBasicMaterial, PointLight } from 'three'
import { beat } from '../../techno/beat'
import { beamAlphaTexture, concreteTexture, radialTexture } from './textures'

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

export const LightRig: React.FC<LightRigProps> = ({ position = [0, 4.2, 0], width = 7, beamLength = 7, tiltDir = 1, trussLength, spill = 18, spillDistance = 4.5 }) => {
  const groups = useRef<(Group | null)[]>([])
  const mats = useRef<(MeshBasicMaterial | null)[]>([])
  const tubeMats = useRef<(MeshBasicMaterial | null)[]>([])
  const strobeMats = useRef<(MeshBasicMaterial | null)[]>([])
  const strobeLight = useRef<PointLight>(null)
  const alpha = useMemo(() => beamAlphaTexture(), [])
  const beamEnv = useEnvelopes(HEADS)
  const tubeEnv = useEnvelopes(TUBES)
  const strobeEnv = useEnvelopes(STROBES)
  const tr = useTriggers()
  const aim = useRef(Array.from({ length: HEADS }, () => ({ z: 0, x: 0.35 })))
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    const T = tr.current
    decayAll(beamEnv.current, delta, 11)
    decayAll(tubeEnv.current, delta, 16)
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
    for (let i = 0; i < HEADS; i++) {
      const g = groups.current[i]
      const mat = mats.current[i]
      if (!g || !mat) continue
      g.visible = beat.lit > 0.001
      if (!g.visible) continue
      const side = i % 2 ? 1 : -1
      // breaks: slow wide sweep instead of snaps
      const brkSweep = beat.breakAmt * Math.sin(beat.time * 0.3 + i * 1.7) * 0.4
      g.rotation.z = aim.current[i].z * groove + brkSweep * side + 0.15 * beat.stab * side
      g.rotation.x = tiltDir * (aim.current[i].x * groove + 0.35 * beat.breakAmt)
      mat.color.copy(PALETTE.cold)
      const e = beamEnv.current.v[i]
      const v = Math.min(1, e * e + drop + 0.06 * beat.breakAmt + 0.08 * beat.stab)
      meter(`beam${i}`, v)
      mat.opacity = 0.9 * v * G
    }
    for (let i = 0; i < TUBES; i++) {
      const m = tubeMats.current[i]
      if (!m) continue
      const v = Math.min(1, tubeEnv.current.v[i] + drop)
      meter(`tube${i}`, v)
      m.color.copy(PALETTE.cold).multiplyScalar((0.015 + v) * G)
    }
    let sMax = 0
    for (let i = 0; i < STROBES; i++) {
      const m = strobeMats.current[i]
      if (!m) continue
      const v = Math.min(1, strobeEnv.current.v[i] + drop)
      sMax = Math.max(sMax, v)
      meter(`strobe${i}`, v)
      m.color.copy(PALETTE.white).multiplyScalar(v * G * 1.0)
    }
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
  return (
    <group position={position}>
      {/* steel truss */}
      <mesh>
        <boxGeometry args={[trussLength ?? width + 1, 0.18, 0.18]} />
        <meshStandardMaterial color={PALETTE.steel} metalness={0.8} roughness={0.5} />
      </mesh>
      {/* strobe fixtures: small bare panels at the truss ends and inner thirds */}
      {Array.from({ length: STROBES }, (_, i) => (
        <group key={`s${i}`} position={[(i - (STROBES - 1) / 2) * ((width + 0.6) / (STROBES - 1)), 0.22, 0.12]}>
          <mesh>
            <boxGeometry args={[0.42, 0.16, 0.08]} />
            <meshStandardMaterial color="#0d0d0d" metalness={0.7} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.045]}>
            <planeGeometry args={[0.36, 0.11]} />
            <meshBasicMaterial ref={(m) => { strobeMats.current[i] = m }} color="#000000" toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* fluorescent tubes hanging in front of the truss */}
      {Array.from({ length: TUBES }, (_, i) => (
        <mesh key={`t${i}`} position={[(i - (TUBES - 1) / 2) * ((width + 0.4) / TUBES), -0.2, 0.25]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 1.2, 8]} />
          <meshBasicMaterial ref={(m) => { tubeMats.current[i] = m }} color="#000000" toneMapped={false} />
        </mesh>
      ))}
      {Array.from({ length: HEADS }, (_, i) => (
        <group key={i} position={[(i - (HEADS - 1) / 2) * (width / (HEADS - 1)), -0.18, 0]} ref={(g) => { groups.current[i] = g }} visible={false}>
          <mesh>
            <cylinderGeometry args={[0.1, 0.14, 0.22, 12]} />
            <meshStandardMaterial color="#0c0c0c" metalness={0.6} roughness={0.5} />
          </mesh>
          {/* narrow, hard beam; alpha fades towards the floor (haze look) */}
          <mesh position={[0, -beamLength / 2 - 0.1, 0]}>
            <coneGeometry args={[0.32 * beamLength / 7 + 0.08, beamLength, 24, 1, true]} />
            <meshBasicMaterial ref={(m) => { mats.current[i] = m }} transparent opacity={0} alphaMap={alpha} blending={AdditiveBlending}
              depthWrite={false} side={DoubleSide} toneMapped={false} />
          </mesh>
        </group>
      ))}
      <pointLight ref={strobeLight} position={[0, -0.5, 0.9]} color={PALETTE.white} distance={spillDistance} decay={2} intensity={0} />
    </group>
  )
}

// ---------------------------------------------------------------- back wall: vertical fluorescent tubes (low-res equalizer)
export interface TubeWallProps {
  position?: [number, number, number]
  width?: number
  height?: number
  /** concrete backing panel (off when mounted on a brick wall) */
  panel?: boolean
  /** soft haze glow behind the tubes (silhouettes the crowd); kept faint and capped */
  haze?: boolean
}

/** 8 bare vertical tubes; hard-gated spectrum (snappy envelopes), kick slams the centre pair, drops slam all */
export const TubeWall: React.FC<TubeWallProps> = ({ position = [0, 0, 0], width = 7, height = 3, panel = true, haze = false }) => {
  const hazeMat = useRef<MeshBasicMaterial>(null)
  const hazeTex = useMemo(() => radialTexture(), [])
  const n = 8
  const mats = useRef<(MeshBasicMaterial | null)[]>([])
  const glow = useRef<Mesh>(null)
  const map = useConcrete(2)
  const env = useEnvelopes(n)
  const tr = useTriggers()
  useFrame((_, delta) => {
    const G = gate()
    const groove = 1 - beat.breakAmt
    const T = tr.current
    decayAll(env.current, delta, 14)
    if (beat.kickN !== T.kickN) {
      T.kickN = beat.kickN
      if (groove > 0.5 && !(beat.riser > 0)) { fire(env.current, 3, 1); fire(env.current, 4, 1) }
    }
    if (beat.step !== T.step) {
      T.step = beat.step
      if (beat.riser > 0) {
        // aggressive outward chase (mirror pairs), one pair per 16th late in the build
        const div = beat.riser > 0.6 ? 1 : 2
        if (beat.step % div === 0) {
          const pair = Math.floor(beat.step / div) % (n / 2)
          fire(env.current, n / 2 - 1 - pair, 1)
          fire(env.current, n / 2 + pair, 1)
        }
      } else if (groove > 0.5 && beat.step % 4 === 2) {
        // offbeat: outer tubes hit only when there is energy in the highs → hard gate, no soft fill
        for (let i = 0; i < n; i++) {
          const band = Math.min(15, Math.abs(i - (n - 1) / 2) * 2 + 0.5) | 0
          if ((beat.levels[band] ?? 0) > 0.45 && i !== 3 && i !== 4) fire(env.current, i, 0.9)
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const m = mats.current[i]
      if (!m) continue
      const e = env.current.v[i]
      const v = Math.min(1, e * e * 1.0 + beat.dropFlash + 0.05 * beat.breakAmt)
      meter(`wall${i}`, v)
      m.color.copy(PALETTE.cold).multiplyScalar(v * G)
    }
    // haze glow: follows the brightest tube, capped low (never a big flash)
    if (hazeMat.current) {
      let mx = 0
      for (let i = 0; i < n; i++) mx = Math.max(mx, env.current.v[i])
      hazeMat.current.opacity = G * Math.min(0.22, 0.03 * (1 - beat.breakAmt) + 0.18 * mx * mx + 0.12 * beat.dropFlash + 0.02 * beat.breakAmt)
    }
    // thin deep-red line at the foot of the wall: kick ambience
    if (glow.current) {
      const k = beat.kickHit * beat.kickHit
      tmpCol.copy(PALETTE.red).multiplyScalar(G * Math.min(1, groove * k + 0.1 * beat.breakAmt + beat.dropFlash))
      ;(glow.current.material as MeshBasicMaterial).color.copy(tmpCol)
    }
  })
  return (
    <group position={position}>
      {panel && (
        <mesh position={[0, 0, -0.08]}>
          <boxGeometry args={[width + 0.6, height + 0.6, 0.12]} />
          <meshStandardMaterial map={map} color={PALETTE.concrete} roughness={0.95} />
        </mesh>
      )}
      {haze && (
        <mesh position={[0, 0, 0.06]}>
          <planeGeometry args={[width * 1.3, height * 1.6]} />
          <meshBasicMaterial ref={hazeMat} color={PALETTE.cold} alphaMap={hazeTex} transparent opacity={0} blending={AdditiveBlending}
            depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={[(i - (n - 1) / 2) * (width / n), 0, 0.02]}>
          <cylinderGeometry args={[0.035, 0.035, height, 8]} />
          <meshBasicMaterial ref={(m) => { mats.current[i] = m }} color="#000000" toneMapped={false} />
        </mesh>
      ))}
      <mesh ref={glow} position={[0, -height / 2 - 0.2, 0.02]}>
        <boxGeometry args={[width, 0.03, 0.03]} />
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
