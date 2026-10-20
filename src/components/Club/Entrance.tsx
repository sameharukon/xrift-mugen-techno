import { Interactable } from '@xrift/world-components'
import { RigidBody } from '@react-three/rapier'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'
import { AdditiveBlending, Group, MeshBasicMaterial, Vector3 } from 'three'
import { club } from '../../techno/club'
import { useConcrete } from '.'
import { brickNormal, brickTexture, radialTexture } from './textures'

/**
 * Entrance: a short, dark concrete corridor outside the club's back wall, ending in a heavy
 * sliding steel door. One faint caged bulb (+ a tiny red pilot lamp) above the door, no text.
 * The door opens (per user) on click, or by walking up to it once a gesture has unlocked audio.
 * Opening it = this user "enters": music opens up (no more muffle) and the club lights fade in.
 *
 * Coordinates are the World's local frame: the club's back wall spans z = zMax .. zMax + wall.
 */
export interface EntranceProps {
  /** club back wall inner face (ROOM.zMax) */
  zMax: number
  wall: number
  /** club width / height (to build the back wall with the doorway cut out) */
  roomWidth: number
  roomHeight: number
  /** corridor length / inner width / height */
  length?: number
  width?: number
  height?: number
}

const DOOR_W = 1.3
const DOOR_H = 2.15
/** door panel overlap past the opening on each side */
const PANEL_W = DOOR_W + 0.16
const PANEL_H = DOOR_H + 0.08
const OPEN_S = 1.5
const TRIGGER_DIST = 1.15
/** the listener must stay in the trigger zone this long (s), and not in the first seconds after load (spawn settling) */
const TRIGGER_HOLD = 0.3
const TRIGGER_GRACE = 2.5

const tmp = new Vector3()

function useBrick(w: number, h: number) {
  return useMemo(() => {
    const t = brickTexture().clone()
    t.repeat.set(w / 2, h / 2)
    t.needsUpdate = true
    return t
  }, [w, h])
}

/** brick normal map sharing the colour map's repeat (cached per map) */
const nCache = new WeakMap<object, import('three').Texture>()
function brickN(map: import('three').Texture) {
  let n = nCache.get(map)
  if (!n) { n = brickNormal().clone(); n.repeat.copy(map.repeat); n.needsUpdate = true; nCache.set(map, n) }
  return n
}

function Box({ p, s, color = '#8a8a8a', map, collide = true, rough = 0.95, metal = 0 }: {
  p: [number, number, number]; s: [number, number, number]; color?: string; map?: import('three').Texture; collide?: boolean; rough?: number; metal?: number
}) {
  const m = (
    <mesh position={p}>
      <boxGeometry args={s} />
      <meshStandardMaterial map={map} normalMap={map ? brickN(map) : undefined} color={color} roughness={rough} metalness={metal} />
    </mesh>
  )
  return collide ? <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>{m}</RigidBody> : m
}

export const Entrance: React.FC<EntranceProps> = ({ zMax, wall, roomWidth, roomHeight, length = 3.6, width = 1.9, height = 2.55 }) => {
  const z0 = zMax + wall // corridor starts at the outer face of the back wall
  const z1 = z0 + length
  const zc = (z0 + z1) / 2
  const sideW = (roomWidth - DOOR_W) / 2
  const brickSide = useBrick(sideW, roomHeight)
  const brickLintel = useBrick(DOOR_W, roomHeight - DOOR_H)
  const brickCorr = useBrick(length, height)
  const brickEnd = useBrick(width, height)
  const floorMap = useConcrete(2)
  const ceilMap = useConcrete(1.5)
  const radial = useMemo(() => radialTexture(), [])

  const group = useRef<Group>(null)
  const slide = useRef<Group>(null)
  const bulb = useRef<MeshBasicMaterial>(null)
  const pilot = useRef<MeshBasicMaterial>(null)
  const [solid, setSolid] = useState(true)
  const opening = useRef(false)
  const nearFor = useRef(0)
  const age = useRef(0)

  const open = () => {
    if (opening.current) return
    opening.current = true
    club.entered = true
    setSolid(false)
  }

  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__openDoor = open

  useFrame(({ camera }, delta) => {
    // listener position relative to the doorway (world → local)
    camera.getWorldPosition(tmp)
    if (group.current) group.current.worldToLocal(tmp)
    if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__camLocal = [+tmp.x.toFixed(2), +tmp.y.toFixed(2), +tmp.z.toFixed(2)]
    const near = tmp.z > z0 - 0.2 && tmp.z - z0 < TRIGGER_DIST && Math.abs(tmp.x) < width / 2 + 0.3
    age.current += delta
    nearFor.current = near && age.current > TRIGGER_GRACE ? nearFor.current + delta : 0
    if (nearFor.current > TRIGGER_HOLD && club.audio) open()
    // 0 inside the club .. 1 in the corridor
    const x = Math.min(1, Math.max(0, (tmp.z - (zMax - 0.8)) / (z0 + 0.8 - (zMax - 0.8))))
    club.outside = x * x * (3 - 2 * x)
    // door animation (ease in-out, heavy)
    if (opening.current) club.door = Math.min(1, club.door + delta / OPEN_S)
    const d = club.door
    const e = d < 0.5 ? 4 * d * d * d : 1 - Math.pow(-2 * d + 2, 3) / 2
    if (slide.current) slide.current.position.x = e * (PANEL_W + 0.25)
    // faint bulb with a slow, small mains-like shimmer (no flashing)
    const tt = performance.now() / 1000
    if (bulb.current) bulb.current.color.setRGB(1, 0.93, 0.82).multiplyScalar(0.32 + 0.02 * Math.sin(tt * 2.1) + 0.012 * Math.sin(tt * 5.3))
    if (pilot.current) pilot.current.color.setRGB(0.8, 0.05, 0.06).multiplyScalar(opening.current ? 0.25 : 0.7)
  })

  const yTop = DOOR_H + (roomHeight - DOOR_H) / 2
  return (
    <group ref={group}>
      {/* club back wall with the doorway cut out (brick) */}
      <Box p={[-(DOOR_W / 2 + sideW / 2), roomHeight / 2, zMax + wall / 2]} s={[sideW, roomHeight, wall]} map={brickSide} color="#9a9a9a" />
      <Box p={[DOOR_W / 2 + sideW / 2, roomHeight / 2, zMax + wall / 2]} s={[sideW, roomHeight, wall]} map={brickSide} color="#9a9a9a" />
      <Box p={[0, yTop, zMax + wall / 2]} s={[DOOR_W, roomHeight - DOOR_H, wall]} map={brickLintel} color="#9a9a9a" />

      {/* corridor: concrete floor, low ceiling, brick walls, dead end behind the spawn */}
      <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, zc]}>
          <planeGeometry args={[width, length]} />
          <meshStandardMaterial map={floorMap} color="#5a5a5a" roughness={0.85} />
        </mesh>
      </RigidBody>
      <Box p={[0, height + 0.05, zc]} s={[width + 0.6, 0.1, length]} map={ceilMap} color="#3a3a3a" />
      <Box p={[-(width / 2 + 0.15), height / 2, zc]} s={[0.3, height, length]} map={brickCorr} color="#7a7a7a" />
      <Box p={[width / 2 + 0.15, height / 2, zc]} s={[0.3, height, length]} map={brickCorr} color="#7a7a7a" />
      <Box p={[0, height / 2, z1 + 0.15]} s={[width + 0.6, height, 0.3]} map={brickEnd} color="#7a7a7a" />
      {/* back wall above the corridor ceiling (closes the gap up to the club height) */}
      {/* a conduit along the ceiling + a cable to the lamp (decor) */}
      <Box p={[-width / 2 + 0.12, height - 0.08, zc]} s={[0.05, 0.05, length]} color="#222" collide={false} rough={0.5} metal={0.7} />

      {/* steel door frame (jambs + head) on the corridor side */}
      {[-1, 1].map((sx) => (
        <Box key={sx} p={[sx * (DOOR_W / 2 + 0.05), DOOR_H / 2, z0 + 0.03]} s={[0.1, DOOR_H, 0.06]} color="#1c1d20" collide={false} rough={0.5} metal={0.8} />
      ))}
      <Box p={[0, DOOR_H + 0.05, z0 + 0.03]} s={[DOOR_W + 0.2, 0.1, 0.06]} color="#1c1d20" collide={false} rough={0.5} metal={0.8} />
      {/* top rail the door hangs from (runs into the right wall) */}
      <Box p={[PANEL_W / 2 + 0.1, DOOR_H + 0.2, z0 + 0.12]} s={[PANEL_W * 2 + 0.4, 0.08, 0.06]} color="#151517" collide={false} rough={0.45} metal={0.85} />

      {/* the door: heavy sliding steel panel, ribbed, pull bar, kick plate */}
      <group position={[0, 0, z0 + 0.1]}>
        {solid && (
          <RigidBody type="fixed" colliders="cuboid">
            <mesh position={[0, PANEL_H / 2, 0]} visible={false}>
              <boxGeometry args={[PANEL_W, PANEL_H, 0.12]} />
            </mesh>
          </RigidBody>
        )}
        <group ref={slide}>
          <Interactable id="club-door" onInteract={() => { club.unlock(); open() }}>
            <group>
              <mesh position={[0, PANEL_H / 2, 0]}>
                <boxGeometry args={[PANEL_W, PANEL_H, 0.08]} />
                <meshStandardMaterial color="#4c4f54" roughness={0.62} metalness={0.4} />
              </mesh>
              {/* horizontal stiffening ribs */}
              {[0.35, 0.8, 1.25, 1.7].map((y) => (
                <mesh key={y} position={[0, y, 0.05]}>
                  <boxGeometry args={[PANEL_W - 0.08, 0.06, 0.03]} />
                  <meshStandardMaterial color="#45484d" roughness={0.55} metalness={0.4} />
                </mesh>
              ))}
              {/* kick plate */}
              <mesh position={[0, 0.12, 0.045]}>
                <boxGeometry args={[PANEL_W - 0.04, 0.22, 0.012]} />
                <meshStandardMaterial color="#3a3c40" roughness={0.4} metalness={0.5} />
              </mesh>
              {/* vertical pull bar on standoffs */}
              <mesh position={[-PANEL_W / 2 + 0.16, 1.05, 0.1]}>
                <cylinderGeometry args={[0.018, 0.018, 0.55, 10]} />
                <meshStandardMaterial color="#8a8d92" roughness={0.3} metalness={0.95} />
              </mesh>
              {[0.82, 1.28].map((y) => (
                <mesh key={y} position={[-PANEL_W / 2 + 0.16, y, 0.07]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.012, 0.012, 0.06, 6]} />
                  <meshStandardMaterial color="#5a5c60" roughness={0.4} metalness={0.9} />
                </mesh>
              ))}
              {/* hanger wheels on the rail */}
              {[-0.45, 0.45].map((x) => (
                <mesh key={x} position={[x, PANEL_H + 0.07, 0.02]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.05, 0.05, 0.04, 12]} />
                  <meshStandardMaterial color="#1a1a1c" roughness={0.5} metalness={0.8} />
                </mesh>
              ))}
            </group>
          </Interactable>
        </group>
      </group>

      {/* caged bulb above the door (faint warm white) + a small red pilot lamp, both unlit-by-music */}
      <group position={[0, DOOR_H + 0.24, z0 + 0.1]}>
        <mesh position={[0, 0.06, -0.04]}>
          <boxGeometry args={[0.12, 0.08, 0.06]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.6} metalness={0.5} />
        </mesh>
        <mesh position={[0, -0.02, 0.04]}>
          <sphereGeometry args={[0.032, 12, 8]} />
          <meshBasicMaterial ref={bulb} color="#000000" toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.02, 0.04]}>
          <sphereGeometry args={[0.05, 8, 6]} />
          <meshStandardMaterial color="#111" wireframe roughness={0.6} metalness={0.6} />
        </mesh>
        <mesh position={[0.24, 0.02, 0.0]}>
          <sphereGeometry args={[0.018, 8, 6]} />
          <meshBasicMaterial ref={pilot} color="#000000" toneMapped={false} />
        </mesh>
        {/* soft halo on the wall behind the lamp (additive decal, fake light) */}
        <mesh position={[0, 0, -0.08 + 0.001]}>
          <planeGeometry args={[1.6, 1.0]} />
          <meshBasicMaterial map={radial} color="#2a221d" transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh position={[0.24, 0.02, -0.08 + 0.002]}>
          <planeGeometry args={[0.35, 0.35]} />
          <meshBasicMaterial map={radial} color="#6a080b" transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        {/* the one real light in the corridor: dim, short range, no shadows */}
        <pointLight position={[0, -0.12, 0.4]} color="#ffe6cc" intensity={1.1} distance={4.5} decay={2} />
      </group>
      {/* faint floor pool in front of the door */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, z0 + 0.9]}>
        <planeGeometry args={[1.8, 1.8]} />
        <meshBasicMaterial map={radial} color="#1c1814" transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}
