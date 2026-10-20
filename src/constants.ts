/** small, low basement room (metres). Booth at the origin, crowd behind it (−z), players / camera at +z */
export const ROOM = {
  width: 10,
  zMin: -5.2,
  zMax: 6.0,
  height: 3.1,
  wall: 0.3,
  /** entrance corridor behind the back wall (z = zMax + wall .. + corridorLength) */
  corridorLength: 3.6,
  /** spawn in the corridor, ≈ 2.8 m in front of the door, facing it (−z) */
  spawnZ: 6.0 + 0.3 + 3.6 - 0.7,
} as const

export const COLORS = {
  /** raw concrete floor (lit only by the show lights) */
  ground: '#6a6a6a',
  /** multiplies the brick texture */
  wall: '#9a9a9a',
  fog: '#000000',
  background: '#000000',
} as const
