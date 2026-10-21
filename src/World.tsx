import { SpawnPoint } from '@xrift/world-components'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Group, Material, Object3D, Texture } from 'three'
import { envReg } from './components/Club/fx'
import { club } from './techno/club'
import { DJBooth, type PAStack } from './components/DJBooth'
import { FloorGlow, LightRig, SceneBackground, SceneFog, TubeWall, useConcrete } from './components/Club'
import { Crowd } from './components/Club/Crowd'
import { Entrance } from './components/Club/Entrance'
import { Bounds } from './components/Club/Bounds'
import { Ceiling } from './components/Club/Props'
import { brickNormal, brickTexture } from './components/Club/textures'
import { ClubEnv, ClubFloor, HaloField, HazeLayers } from './components/Club/Fx'
import { COLORS, ROOM } from './constants'
import { DevCamOverride } from './devCam'

export interface WorldProps {
  position?: [number, number, number]
  scale?: number
}

/**
 * Small, low basement club: booth in the middle of the crowd, crowd packed behind the DJ facing the
 * "camera" side (+z). Players spawn outside, in a short corridor behind the back wall, and enter through
 * a heavy door; the music runs forever (clock-derived), the club is black until you are inside.
 */
/** 4 PA stacks against the side walls (front pair by the booth, fill pair towards the spawn), aimed at the floor centre */
const PA_STACKS: PAStack[] = ([[-1, -1.3], [1, -1.3], [-1, 3.0], [1, 3.0]] as const).map(([side, z]) => {
  const x = side * (ROOM.width / 2 - 0.6)
  return { position: [x, 0, z] as [number, number, number], yaw: Math.atan2(-x, 1 - z), side: side < 0 ? 'L' : 'R' }
})

/**
 * The club interior is not drawn while this user stands outside behind the closed door (saves ~40 draw calls).
 * Renderables and the interior lights are hidden (the corridor renders with its single light). The light count
 * is part of every shader's program key, so the warm-up below also renders with the interior lights on: both
 * variants (corridor-only and full club) are compiled before the door ever opens.
 * Pre-warm: shortly after load (and again when an XR session starts) the hidden interior is drawn for a few
 * real frames in small chunks, frustum culling off, while the player is still in the corridor. It is fully
 * occluded by the closed door / walls and black (club lights are off until entering), but it compiles the exact
 * program variants, uploads textures / geometry / instance buffers, so opening the door costs nothing extra.
 */
type Renderable = Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isLight?: boolean }
const isRenderable = (o: Renderable) => !!(o.isMesh || o.isPoints || o.isLine || o.isSprite || o.isLight)
const isLight = (o: Renderable) => !!o.isLight
const WARM_CHUNKS = 6
const CullWhileClosed: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const g = useRef<Group>(null)
  const gl = useThree((s) => s.gl)
  const st = useRef({ shown: true, age: 0, warm: -1, warmList: [] as Renderable[], culled: new Map<Renderable, boolean>(), xr: false })
  useEffect(() => {
    const onXR = () => { st.current.xr = true }
    gl.xr.addEventListener('sessionstart', onXR)
    return () => gl.xr.removeEventListener('sessionstart', onXR)
  }, [gl])
  useFrame(({ scene, camera }, delta) => {
    const root = g.current
    if (!root) return
    const S = st.current
    S.age += delta
    const show = club.door > 0 || club.outside < 0.999
    // finish a previous warm chunk: re-hide it, restore frustum culling
    if (S.culled.size) {
      for (const [o, fc] of S.culled) { o.frustumCulled = fc; if (!show) o.visible = false }
      S.culled.clear()
    }
    if (show) {
      if (!S.shown) { root.traverse((o) => { if (isRenderable(o as Renderable)) o.visible = true }); S.shown = true }
      // the interior has now been drawn for real: everything is compiled / uploaded → hiding it again later
      // (door closes behind you, back in the corridor) needs no new warm-up
      if (S.warm !== -2) S.warm = WARM_CHUNKS
      return
    }
    // hidden: keep every renderable (also newly mounted ones) invisible
    root.traverse((o) => { if (isRenderable(o as Renderable)) o.visible = false })
    S.shown = false
    // schedule warm-ups: ~1.5 s after load (env map ready) and right after an XR session starts
    if (club.syncing) return // never compete with the late-join fast-forward (keeps join latency)
    if ((S.warm === -1 && S.age > 1.5 && envReg.tex) || (S.xr && S.warm !== -2)) {
      S.xr = false
      S.warmList = []
      root.traverse((o) => { if (isRenderable(o as Renderable)) S.warmList.push(o as Renderable) })
      for (const o of S.warmList) {
        const m = (o as unknown as { material?: Material | Material[] }).material
        for (const mm of Array.isArray(m) ? m : m ? [m] : []) for (const v of Object.values(mm as unknown as Record<string, unknown>).concat(Object.values((mm as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms ?? {}).map((u) => u.value))) if (v && (v as Texture).isTexture) gl.initTexture(v as Texture)
      }
      // 1) compile every interior program off the main thread where KHR_parallel_shader_compile exists
      //    (renderer.compileAsync on the temporarily revealed interior), 2) then draw it in chunks (uploads)
      S.warm = -2
      for (const o of S.warmList) o.visible = true
      const done = () => { if (S.warm === -2) S.warm = 0; if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__warmProgs = [gl.info.programs?.length, performance.now()] }
      const tc = performance.now()
      try { gl.compileAsync(scene, camera).then(done, done) } catch { done() }
      if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__warmCompile = { at: tc, syncMs: performance.now() - tc, parallel: !!gl.extensions.get('KHR_parallel_shader_compile') }
      for (const o of S.warmList) o.visible = false
    }
    if (S.warm >= 0 && S.warm < WARM_CHUNKS) {
      const n = Math.ceil(S.warmList.length / WARM_CHUNKS)
      const chunk = S.warmList.slice(S.warm * n, (S.warm + 1) * n).concat(S.warmList.filter(isLight))
      for (const o of chunk) { S.culled.set(o, o.frustumCulled); o.frustumCulled = false; o.visible = true }
      S.warm++
      if (import.meta.env.DEV) ((globalThis as Record<string, unknown>).__warmChunks ??= [] as unknown[]) && ((globalThis as Record<string, unknown>).__warmChunks as unknown[]).push([S.warm, gl.info.programs?.length, performance.now()])
      if (import.meta.env.DEV && S.warm === WARM_CHUNKS) (globalThis as Record<string, unknown>).__warmDone = performance.now()
    }
  })
  return <group ref={g}>{children}</group>
}

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const { width, zMin, zMax, height, wall } = ROOM
  const depth = zMax - zMin
  const zc = (zMin + zMax) / 2
  const ceilMap = useConcrete(3)
  const brickSide = useMemo(() => { const t = brickTexture().clone(); t.repeat.set(depth / 2, height / 2); t.needsUpdate = true; return t }, [depth, height])
  const nSide = useMemo(() => { const t = brickNormal().clone(); t.repeat.set(depth / 2, height / 2); t.needsUpdate = true; return t }, [depth, height])
  const nEnd = useMemo(() => { const t = brickNormal().clone(); t.repeat.set(width / 2, height / 2); t.needsUpdate = true; return t }, [width, height])
  const brickEnd = useMemo(() => { const t = brickTexture().clone(); t.repeat.set(width / 2, height / 2); t.needsUpdate = true; return t }, [width, height])

  return (
    <group position={position} scale={scale}>
      {/* ========== 環境（真っ暗。照明は再生中の演出のみ / 地下の小さなクラブ） ========== */}
      <SceneFog color={COLORS.fog} near={3} far={17} />
      <SceneBackground color={COLORS.background} />
      {/* v18: no collider on the visual floor / walls / ceiling — <Bounds> provides one continuous floor slab and thick walls */}
      <ClubFloor width={width} depth={depth} zc={zc} color={COLORS.ground} />

      {/* ========== 壁（レンガ）・低い天井（ダクト / 配管） ========== */}
      {([
        [[width / 2 + wall / 2, height / 2, zc], [wall, height, depth], brickSide, nSide],
        [[-width / 2 - wall / 2, height / 2, zc], [wall, height, depth], brickSide, nSide],
        [[0, height / 2, zMin - wall / 2], [width, height, wall], brickEnd, nEnd],
      ] as const).map(([p, s, map, nmap], i) => (
        <mesh key={i} position={p as unknown as [number, number, number]}>
          <boxGeometry args={s as unknown as [number, number, number]} />
          <meshStandardMaterial map={map} normalMap={nmap} color={COLORS.wall} roughness={0.88} />
        </mesh>
      ))}
      {/* v18: thick invisible boundary colliders (walls, ceilings + safety caps, floor under everything) */}
      <Bounds />
      <Ceiling width={width} zMin={zMin} zMax={zMax} height={height} map={ceilMap} />

      {/* ========== DJブース（人の中心）・クラウド・照明（全員で同期） ========== */}
      <CullWhileClosed>
      <DJBooth position={[0, 0, 0]} pa={PA_STACKS} />
      <Crowd />
      {/* back wall tubes behind the crowd → silhouettes */}
      <TubeWall position={[0, 1.45, zMin + 0.08]} width={width - 1.6} height={2.1} panel={false} haze />
      {/* low truss above the back of the crowd, beams tilted towards the booth / camera (backlight) */}
      <LightRig position={[0, height - 0.55, zMin + 1.6]} width={width - 2.4} beamLength={3.6} tiltDir={-1} trussLength={width - 0.4} spill={7} spillDistance={3.2} />
      {/* red kick light from booth/truss height behind the DJ (backlights heads & shoulders); only a small, faint pool on the floor */}
      {/* v12: dark env reflections, haze sheets at head height, fake bloom halos */}
      <ClubEnv />
      <HazeLayers width={width - 0.2} zMin={zMin + 0.1} zMax={zMax - 0.3} wallZ={zMin + 0.08} />
      <FloorGlow position={[0, 0, -1.4]} size={3} distance={4.5} lightHeight={2.5} peak={14} poolMax={0.18} />
      </CullWhileClosed>
      {/* fake-bloom halos (one draw; also used by the entrance lamp, so not culled with the interior) */}
      <HaloField />
      {import.meta.env.DEV && <DevCamOverride />}

      {/* ========== 入口（クラブの外の短い通路と重い鉄扉。扉を開けると音と光が入る） ========== */}
      <Entrance zMax={zMax} wall={wall} roomWidth={width} roomHeight={height} length={ROOM.corridorLength} />

      {/* ========== スポーン（扉の前の暗い通路） ========== */}
      <group position={[0, 0, ROOM.spawnZ]}>
        <SpawnPoint />
      </group>
    </group>
  )
}
