import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { ROOM } from '../../constants'

/**
 * v18: invisible, thick boundary colliders (no meshes → no draw calls / programs).
 * The visible walls / ceilings / floors keep their own (thin) colliders; these slabs sit flush with the
 * inner faces and extend OUTWARD (5 m), so a fast or low-fps player can't tunnel out of the club or the
 * corridor, can't jump through a ceiling, and there is a solid floor under everything.
 * Corridor / door geometry must match Entrance.tsx (DOOR_W 1.3, DOOR_H 2.15, corridor width 1.9, height 2.55).
 */
/** slab thickness (m). @react-three/rapier clamps a frame's physics step to 0.5 s: walking (5 m/s) that is a 2.5 m jump
 *  per step, so a slab must be thick enough that the capsule still ends up nearer its INNER face after the worst hitch */
const T = 5
/** vertical slabs start this far above the floor: the player's feet (grounded) sensor never touches a wall, so it
 *  only ever sees ONE floor collider (its enter / exit events can't be confused by walls / floor seams). The gap is far
 *  too small for the 0.4 m-radius capsule. */
const FOOT = 0.1
const UP = 7 // walls reach well above the ceilings (no gaps at the corners / wall tops)
const DOOR_W = 1.3
const DOOR_H = 2.15
const COR_W = 1.9
const COR_H = 2.55

/** axis-aligned box from min / max corners */
const Slab: React.FC<{ min: [number, number, number]; max: [number, number, number] }> = ({ min, max }) => (
  <CuboidCollider
    args={[(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]}
    position={[(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2]}
  />
)

export const Bounds: React.FC = () => {
  const { width, zMin, zMax, height, wall, corridorLength } = ROOM
  const hw = width / 2
  const z0 = zMax + wall // corridor start (outer face of the club's back wall)
  const z1 = z0 + corridorLength // corridor dead end (inner face)
  const cw = COR_W / 2
  const X = hw + T // outer extent in x
  const Z0 = zMin - T, Z1 = z1 + T // outer extents in z
  return (
    <RigidBody type="fixed" colliders={false} restitution={0} friction={0}>
      {/* floor under everything (club, doorway, corridor, wall footprints) */}
      <Slab min={[-X, -T, Z0]} max={[X, 0, Z1]} />
      {/* club: ceiling + safety cap above it, side walls, front wall */}
      <Slab min={[-X, height, Z0]} max={[X, height + T * 2, zMax + wall]} />
      <Slab min={[hw, FOOT, Z0]} max={[X, UP, z0]} />
      <Slab min={[-X, FOOT, Z0]} max={[-hw, UP, z0]} />
      <Slab min={[-X, FOOT, Z0]} max={[X, UP, zMin]} />
      {/* club back wall (door wall): both sides of the doorway + above it (wall thickness), thickened outward beside the corridor */}
      <Slab min={[-X, FOOT, zMax]} max={[-DOOR_W / 2, UP, z0]} />
      <Slab min={[DOOR_W / 2, FOOT, zMax]} max={[X, UP, z0]} />
      <Slab min={[-DOOR_W / 2, DOOR_H, zMax]} max={[DOOR_W / 2, UP, z0]} />
      <Slab min={[-X, FOOT, z0]} max={[-cw - 0.3, UP, z0 + T]} />
      <Slab min={[cw + 0.3, FOOT, z0]} max={[X, UP, z0 + T]} />
      {/* corridor: walls, dead end, ceiling + cap */}
      <Slab min={[cw, FOOT, z0]} max={[cw + T, UP, Z1]} />
      <Slab min={[-cw - T, FOOT, z0]} max={[-cw, UP, Z1]} />
      <Slab min={[-cw - T, FOOT, z1]} max={[cw + T, UP, Z1]} />
      <Slab min={[-cw - T, COR_H, zMax]} max={[cw + T, COR_H + T * 2, Z1]} />
    </RigidBody>
  )
}
