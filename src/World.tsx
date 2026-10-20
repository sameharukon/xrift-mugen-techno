import { SpawnPoint } from '@xrift/world-components'
import { RigidBody } from '@react-three/rapier'
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import { club } from './techno/club'
import { DJBooth, type PAStack } from './components/DJBooth'
import { FloorGlow, LightRig, SceneBackground, SceneFog, TubeWall, useConcrete } from './components/Club'
import { Crowd } from './components/Club/Crowd'
import { Entrance } from './components/Club/Entrance'
import { Ceiling, TripodCamera } from './components/Club/Props'
import { brickTexture } from './components/Club/textures'
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

/** the club interior is not drawn while this user stands outside behind the closed door (saves ~40 draw calls) */
const CullWhileClosed: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const g = useRef<Group>(null)
  useFrame(() => {
    if (g.current) g.current.visible = club.door > 0 || club.outside < 0.999
  })
  return <group ref={g}>{children}</group>
}

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const { width, zMin, zMax, height, wall } = ROOM
  const depth = zMax - zMin
  const zc = (zMin + zMax) / 2
  const floorMap = useConcrete(5)
  const ceilMap = useConcrete(3)
  const brickSide = useMemo(() => { const t = brickTexture().clone(); t.repeat.set(depth / 2, height / 2); t.needsUpdate = true; return t }, [depth, height])
  const brickEnd = useMemo(() => { const t = brickTexture().clone(); t.repeat.set(width / 2, height / 2); t.needsUpdate = true; return t }, [width, height])

  return (
    <group position={position} scale={scale}>
      {/* ========== 環境（真っ暗。照明は再生中の演出のみ / 地下の小さなクラブ） ========== */}
      <SceneFog color={COLORS.fog} near={3} far={17} />
      <SceneBackground color={COLORS.background} />
      <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, zc]}>
          <planeGeometry args={[width, depth]} />
          <meshStandardMaterial map={floorMap} color={COLORS.ground} roughness={0.8} metalness={0.05} />
        </mesh>
      </RigidBody>

      {/* ========== 壁（レンガ）・低い天井（ダクト / 配管） ========== */}
      {([
        [[width / 2 + wall / 2, height / 2, zc], [wall, height, depth], brickSide],
        [[-width / 2 - wall / 2, height / 2, zc], [wall, height, depth], brickSide],
        [[0, height / 2, zMin - wall / 2], [width, height, wall], brickEnd],
      ] as const).map(([p, s, map], i) => (
        <RigidBody key={i} type="fixed" colliders="cuboid" restitution={0} friction={0}>
          <mesh position={p as unknown as [number, number, number]}>
            <boxGeometry args={s as unknown as [number, number, number]} />
            <meshStandardMaterial map={map} color={COLORS.wall} roughness={0.95} />
          </mesh>
        </RigidBody>
      ))}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[0, height + 0.1, zc]} visible={false}>
          <boxGeometry args={[width, 0.2, depth]} />
        </mesh>
      </RigidBody>
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
      <FloorGlow position={[0, 0, -1.4]} size={3} distance={4.5} lightHeight={2.5} peak={14} poolMax={0.18} />
      <TripodCamera position={[1.2, 0, 1.5]} yaw={Math.atan2(1.2, 1.5 + 0.95)} />
      </CullWhileClosed>
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
