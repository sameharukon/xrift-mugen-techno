/** small, low basement room (metres). Booth at the origin, crowd behind it (−z), players / camera at +z */
export const ROOM = {
  width: 10,
  zMin: -5.2,
  zMax: 6.0,
  height: 3.1,
  wall: 0.3,
  /** just inside the crowd ring, in the clear gap in front of the booth (button ≈ 1.7 m ahead) */
  spawnZ: 2.1,
} as const

export const COLORS = {
  /** raw concrete floor (lit only by the show lights) */
  ground: '#6a6a6a',
  /** multiplies the brick texture */
  wall: '#9a9a9a',
  fog: '#000000',
  background: '#000000',
} as const
