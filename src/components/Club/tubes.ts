/**
 * v19: one shared fluorescent-tube look for the truss tubes and the back-wall tubes.
 * - unit-length open cylinder (instance matrix scales y to the tube length), radius TUBE_R
 * - ONE ShaderMaterial (instanced, per-instance colour = brightness × tint): bright core, softer edges (glass seen
 *   edge-on), darker / warmer electrode ends with blackened tips, a faint glass sheen when off, scene fog
 * - the wall layout: hand-placed, slightly crooked tubes (deterministic), plus their fixtures (end caps / lampholders,
 *   clips, conduit and a few loose sagging cables) as merged geometry
 */
import { CatmullRomCurve3, Color, CylinderGeometry, Euler, ShaderMaterial, TorusGeometry, TubeGeometry, UniformsLib, UniformsUtils, Vector3, Matrix4, Quaternion } from 'three'
import { Builder, box, cyl, rbox } from './geo'
import { BRUSH_TILE } from './textures'

export const TUBE_R = 0.03
/** idle level of every tube (unlit glass + a hint of glow) — same for truss and wall */
export const TUBE_IDLE = 0.015
/** halo per tube: same radius / strength everywhere (the halo is a capsule along the whole tube → same per metre) */
export const TUBE_HALO_R = 0.2
export const TUBE_HALO_I = 0.65
/** shared envelope: decay rate and curve (v = e²) for both sets */
export const TUBE_DECAY = 14

let geo: CylinderGeometry | null = null
export const tubeGeometry = () => (geo ??= new CylinderGeometry(TUBE_R, TUBE_R, 1, 14, 1, true))

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vN;
varying vec3 vW;
varying float vEnd;
varying vec3 vCol;
void main() {
  float L = length(instanceMatrix[1].xyz);
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vEnd = min(uv.y, 1.0 - uv.y) * L; // metres from the nearest end
#ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
#else
  vCol = vec3(0.0);
#endif
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`
const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uGlass;
varying vec3 vN;
varying vec3 vW;
varying float vEnd;
varying vec3 vCol;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float f = abs(dot(normalize(vN), V));
  // bright core, softer / dimmer towards the silhouette (thin phosphor layer seen edge-on)
  float core = 0.5 + 1.1 * pow(f, 0.65); // the core clips to near-white at a full hit (like the old flat tubes), edges stay softer
  vec3 c = vCol * core;
  // electrode ends: the last few cm run warmer and darker, the very tips blackened
  float e = smoothstep(0.015, 0.08, vEnd);
  c = mix(c * vec3(1.0, 0.8, 0.6) * 0.5, c, e) * (0.3 + 0.7 * smoothstep(0.0, 0.022, vEnd));
  // glass: a faint sheen at the edges, also when off
  c += uGlass * (0.35 + 0.65 * (1.0 - f));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`
let mat: ShaderMaterial | null = null
/** the one tube material (shared by both instanced meshes → one program) */
export const tubeMaterial = () => (mat ??= new ShaderMaterial({
  vertexShader: VERT, fragmentShader: FRAG, fog: true, toneMapped: false,
  uniforms: UniformsUtils.merge([UniformsLib.fog, { uGlass: { value: new Color(0, 0, 0) } }]),
}))

// ---------------------------------------------------------------- back-wall layout
const h = (a: number, b: number) => {
  let x = (a * 374761393 + b * 668265263) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}
export interface WallTube {
  /** centre (wall-local: x across, y above the floor) */
  x: number
  y: number
  len: number
  /** in-wall rotation (rad), 0 = vertical, ±π/2 = horizontal */
  tilt: number
}
/**
 * Hand-installed look: uneven gaps, mixed lengths (0.6 / 1.2 / 1.5 / 2.1 m), a few degrees off plumb, one tube clearly
 * leaning, one mounted horizontally up high, a clustered pair left of centre, a short one low on the right.
 * Lowest glass ≥ 0.5 m above the floor (feet / floor stay dark). Left / right total length is balanced.
 * A small seeded jitter (± 3 cm, ± 0.6°) on top of the authored positions.
 */
const AUTHORED: [number, number, number, number][] = [
  // x, y, len, tilt (deg)
  [-3.92, 1.6, 2.1, 1.8],
  [-3.08, 1.98, 1.2, -6.5],
  [-2.5, 1.32, 1.5, 3.5],
  [-1.62, 1.62, 2.1, -1.2],
  [-0.66, 1.78, 1.5, 2.4],
  [-0.46, 1.62, 1.2, -1.6],
  [0.57, 1.58, 2.1, 0.9],
  [1.42, 2.32, 1.2, 90],
  [1.98, 1.4, 1.5, -15],
  [2.86, 1.6, 2.1, 0.6],
  [3.5, 1.12, 0.6, 5],
  [4.0, 1.82, 1.5, -2.8],
]
export const WALL_TUBES: WallTube[] = AUTHORED.map(([x, y, len, deg], i) => ({
  x: x + (h(i, 1) - 0.5) * 0.06,
  y: y + (h(i, 2) - 0.5) * 0.06,
  len,
  tilt: ((deg + (h(i, 3) - 0.5) * 1.2) * Math.PI) / 180,
}))
/** unit direction of a wall tube (wall-local xy) */
export const tubeDir = (t: WallTube) => new Vector3(-Math.sin(t.tilt), Math.cos(t.tilt), 0)
/** instance matrix (unit cylinder → this tube), tube axis z = zc in front of the wall */
export function wallTubeMatrix(t: WallTube, zc: number) {
  return new Matrix4().compose(new Vector3(t.x, t.y, zc), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), t.tilt), new Vector3(1, t.len, 1))
}

/**
 * Fixtures for the wall tubes (wall-local; wall face at z = wallZ, tube axis at z = zc):
 * metal: end caps + lampholder blocks to the wall, wrap-around clips on short brackets, conduit up to the ceiling
 * (or across to the neighbour), junction boxes; rubber: a few loose feed cables sagging between holders.
 */
const BACK_FEED_PAIRS: [number, number][] = [[0, 1], [4, 5], [7, 8], [10, 11], [2, 3]]
export function wallFixtures(list: WallTube[], wallZ: number, zc: number, ceilY: number, pairs: [number, number][] = BACK_FEED_PAIRS, seed = 0) {
  const metal = new Builder(BRUSH_TILE), rubber = new Builder()
  const up = new Vector3(0, 1, 0)
  const place = (p: Vector3, d: Vector3, rollZ = 0) => {
    const q = new Quaternion().setFromUnitVectors(up, d)
    if (rollZ) q.multiply(new Quaternion().setFromAxisAngle(up, rollZ))
    return new Matrix4().compose(p, q, new Vector3(1, 1, 1))
  }
  const ends: Vector3[] = []
  list.forEach((t, i0) => {
    const i = i0 + seed
    const d = tubeDir(t)
    const c = new Vector3(t.x, t.y, zc)
    const back = zc - wallZ
    let top = c.clone()
    for (const s of [-1, 1]) {
      const e = c.clone().addScaledVector(d, s * (t.len / 2 + 0.022))
      // end cap (same as the truss tubes) + lampholder block back to the wall
      metal.add(cyl(0.04, 0.04, 0.05, 14), place(e, d))
      metal.add(cyl(0.012, 0.012, 0.02, 6), place(e.clone().addScaledVector(d, s * 0.03), d)) // pin housing
      metal.add(rbox(0.06, 0.05, back + 0.01, 0.008), new Matrix4().compose(new Vector3(e.x, e.y, wallZ + (back + 0.01) / 2), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), t.tilt), new Vector3(1, 1, 1)))
      if (e.y > top.y) top = e
    }
    ends.push(top)
    // clips: 1 on 1.2 / 1.5 m, 2 on 2.1 m, none on the short one
    const nClip = t.len >= 2 ? 2 : t.len >= 1.1 ? 1 : 0
    for (let k = 0; k < nClip; k++) {
      const off = nClip === 1 ? (h(i, 9) - 0.5) * 0.2 : (k ? 1 : -1) * t.len * (0.24 + 0.04 * h(i, 10 + k))
      const p = c.clone().addScaledVector(d, off)
      const ring = new TorusGeometry(TUBE_R + 0.004, 0.0035, 5, 14, Math.PI)
      ring.rotateX(Math.PI / 2) // front half-ring around the tube (axis = local y)
      metal.add(ring, place(p, d))
      metal.add(box(0.014, 0.014, back), new Matrix4().compose(new Vector3(p.x, p.y, wallZ + back / 2), new Quaternion(), new Vector3(1, 1, 1)))
      metal.add(box(0.05, 0.03, 0.006), new Matrix4().compose(new Vector3(p.x, p.y, wallZ + 0.003), new Quaternion(), new Vector3(1, 1, 1))) // wall plate
    }
    // feed: conduit from the upper holder straight up to the ceiling (most), a junction box on some
    if (h(i, 20) < 0.7 || i === 7) {
      const y0 = top.y + 0.03, len = ceilY - y0
      metal.add(cyl(0.011, 0.011, len, 8), new Matrix4().makeTranslation(top.x + (h(i, 21) - 0.5) * 0.03, y0 + len / 2, wallZ + 0.016))
      for (let y = y0 + 0.35 + 0.2 * h(i, 22); y < ceilY - 0.1; y += 0.55 + 0.2 * h(i, 23))
        metal.add(box(0.035, 0.012, 0.025), new Matrix4().makeTranslation(top.x, y, wallZ + 0.013)) // saddle clips
      if (h(i, 24) < 0.45) metal.add(rbox(0.08, 0.08, 0.04, 0.006), new Matrix4().makeTranslation(top.x, Math.min(ceilY - 0.12, y0 + 0.18), wallZ + 0.02))
    }
  })
  // loose cables: a few holders fed sideways from the neighbour, sagging (hand-run, not on a grid)
  for (const [a, b] of pairs) {
    const A = ends[a], B = ends[b]
    const mid = A.clone().lerp(B, 0.5)
    const sag = 0.12 + 0.18 * h(a, 30) + 0.04 * Math.abs(A.x - B.x)
    const pts = [A.clone().setZ(wallZ + 0.03), A.clone().lerp(mid, 0.5).setZ(wallZ + 0.04).add(new Vector3(0, -sag * 0.75, 0)), mid.clone().setZ(wallZ + 0.045).add(new Vector3(0, -sag, 0)), B.clone().lerp(mid, 0.5).setZ(wallZ + 0.04).add(new Vector3(0, -sag * 0.75, 0)), B.clone().setZ(wallZ + 0.03)]
    rubber.add(new TubeGeometry(new CatmullRomCurve3(pts), 28, 0.006, 6, false))
  }
  return { metal: metal.build(), rubber: rubber.build() }
}

// ---------------------------------------------------------------- booth-front ceiling tubes (v21b)
export interface CeilTube {
  /** centre (room frame: x across, z towards the door) */
  x: number
  z: number
  /** ceiling → tube axis (m): small = surface-mounted holders, larger = hung on two wires */
  drop: number
  len: number
  /** plan angle (rad, 0 = along x) and hang angle (rad, one end lower) */
  yaw: number
  tilt: number
}
/**
 * Above the floor in front of the booth (where people stand facing the DJ): five tubes put up by hand — mixed lengths,
 * mixed drops, not parallel, one short surface-mounted one off to the side. Kept clear of the ducts (|x| ≈ 3) and of the
 * cross pipe at z = 2.0. Lowest glass ≈ 2.6 m.
 */
const CEIL_AUTHORED: [number, number, number, number, number, number][] = [
  // x, z, drop, len, yaw (deg), tilt (deg)
  [-1.55, 1.25, 0.32, 1.5, 6, 2.5],
  [0.75, 1.05, 0.18, 1.2, -9, -1],
  [1.95, 2.95, 0.07, 1.2, 78, 0],
  [-0.45, 3.35, 0.42, 1.5, -14, 4],
  [-2.25, 2.6, 0.07, 0.6, 95, 0],
]
export const CEIL_TUBES: CeilTube[] = CEIL_AUTHORED.map(([x, z, drop, len, yaw, tilt], i) => ({
  x: x + (h(i, 41) - 0.5) * 0.06,
  z: z + (h(i, 42) - 0.5) * 0.06,
  drop: drop + (h(i, 43) - 0.5) * 0.02,
  len,
  yaw: ((yaw + (h(i, 44) - 0.5) * 3) * Math.PI) / 180,
  tilt: ((tilt + (h(i, 45) - 0.5) * 0.8) * Math.PI) / 180,
}))
/** instance matrix (unit cylinder → this tube) */
export function ceilTubeMatrix(t: CeilTube, ceilY: number, len = t.len) {
  return new Matrix4().compose(new Vector3(t.x, ceilY - t.drop, t.z), new Quaternion().setFromEuler(new Euler(0, t.yaw, Math.PI / 2 + t.tilt, 'YXZ')), new Vector3(1, len, 1))
}
/**
 * Fixtures: end caps on every tube; surface-mounted tubes get lampholder blocks up into the ceiling, hung tubes get
 * two wires + a small ceiling plate each (the plates sink 2 mm into the ceiling → no coplanar faces); a few feed
 * cables sag between neighbouring holders.
 */
export function ceilFixtures(list: CeilTube[], ceilY: number) {
  const metal = new Builder(BRUSH_TILE), rubber = new Builder()
  const holders: Vector3[] = []
  list.forEach((t) => {
    const M = ceilTubeMatrix(t, ceilY, 1)
    const q = new Quaternion().setFromRotationMatrix(M)
    for (const s of [-1, 1]) {
      metal.add(cyl(0.04, 0.04, 0.05, 14), new Matrix4().compose(new Vector3(0, s * (t.len / 2 + 0.025), 0).applyMatrix4(M), q, new Vector3(1, 1, 1)))
      metal.add(cyl(0.012, 0.012, 0.02, 6), new Matrix4().compose(new Vector3(0, s * (t.len / 2 + 0.06), 0).applyMatrix4(M), q, new Vector3(1, 1, 1))) // pin housing
      const yawQ = new Quaternion().setFromEuler(new Euler(0, t.yaw, 0))
      if (t.drop < 0.12) {
        // lampholder block from the end cap up into the ceiling
        const e = new Vector3(0, s * (t.len / 2 + 0.025), 0).applyMatrix4(M)
        const hgt = ceilY + 0.002 - e.y
        metal.add(rbox(0.05, hgt, 0.06, 0.008), new Matrix4().compose(new Vector3(e.x, e.y + hgt / 2, e.z), yawQ, new Vector3(1, 1, 1)))
        holders.push(new Vector3(e.x, ceilY - 0.012, e.z))
      } else {
        const a = t.len / 2 - (t.len > 1.3 ? 0.2 : 0.15)
        const w = new Vector3(0, s * a, 0).applyMatrix4(M)
        const top = ceilY - 0.01, len = top - (w.y + 0.03)
        metal.add(cyl(0.004, 0.004, len, 4), new Matrix4().makeTranslation(w.x, w.y + 0.03 + len / 2, w.z))
        metal.add(rbox(0.07, 0.012, 0.07, 0.004), new Matrix4().compose(new Vector3(w.x, ceilY - 0.004, w.z), yawQ, new Vector3(1, 1, 1)))
        // wrap-around clip where the wire meets the tube
        const ring = new TorusGeometry(TUBE_R + 0.004, 0.0035, 5, 14, Math.PI)
        ring.rotateX(Math.PI / 2).rotateY(Math.PI / 2) // upper half-ring (tube-local +x = up)
        metal.add(ring, new Matrix4().compose(new Vector3(0, s * a, 0).applyMatrix4(M), q, new Vector3(1, 1, 1)))
        holders.push(new Vector3(w.x, ceilY - 0.012, w.z))
      }
    }
  })
  // feed cables sagging under the ceiling between a few neighbouring holders (hand-run)
  for (const [a, b] of [[1, 2], [6, 7], [0, 9]] as const) {
    const A = holders[a], B = holders[b]
    if (!A || !B) continue
    const sag = 0.08 + 0.05 * A.distanceTo(B)
    const mid = A.clone().lerp(B, 0.5).add(new Vector3(0, -sag, 0))
    const pts = [A, A.clone().lerp(mid, 0.5).add(new Vector3(0, -sag * 0.3, 0)), mid, B.clone().lerp(mid, 0.5).add(new Vector3(0, -sag * 0.3, 0)), B]
    rubber.add(new TubeGeometry(new CatmullRomCurve3(pts), 28, 0.006, 6, false))
  }
  return { metal: metal.build(), rubber: rubber.build() }
}

// ---------------------------------------------------------------- side walls (v23a)
/**
 * Side-wall tubes, hand-placed between the PA stacks / flight cases / paint patches (world z, y, len, tilt°).
 * Left wall x = −W/2, right wall x = +W/2; fewer on the right (power run + crate corner), mixed vertical / crooked /
 * one high horizontal each side.
 */
const SIDE_AUTHORED: Record<'L' | 'R', [number, number, number, number][]> = {
  L: [[-4.3, 1.75, 1.5, 3], [-2.3, 2.2, 1.2, 84], [0.6, 1.6, 2.1, -2], [1.75, 2.05, 0.6, 12], [4.6, 1.7, 1.5, -4]],
  R: [[-3.4, 1.65, 1.5, -2], [-0.2, 2.25, 1.5, -86], [1.3, 1.5, 1.2, 6], [4.4, 1.75, 2.1, 1]],
}
export interface SideTube extends WallTube { side: -1 | 1; z: number }
/** wall-local x: left wall group is rotated +90° (local x = −world z), right wall −90° (local x = +world z) */
export const SIDE_TUBES: Record<'L' | 'R', SideTube[]> = {
  L: SIDE_AUTHORED.L.map(([z, y, len, deg], i) => ({ side: -1, z, x: -z + (h(i, 31) - 0.5) * 0.05, y: y + (h(i, 32) - 0.5) * 0.05, len, tilt: ((deg + (h(i, 33) - 0.5) * 1.5) * Math.PI) / 180 })),
  R: SIDE_AUTHORED.R.map(([z, y, len, deg], i) => ({ side: 1, z, x: z + (h(i, 41) - 0.5) * 0.05, y: y + (h(i, 42) - 0.5) * 0.05, len, tilt: ((deg + (h(i, 43) - 0.5) * 1.5) * Math.PI) / 180 })),
}
export const SIDE_FEED_PAIRS: Record<'L' | 'R', [number, number][]> = { L: [[0, 1], [3, 2]], R: [[2, 1]] }
