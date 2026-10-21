/** small helpers to build merged static/decor geometry (one draw per material) */
import { BoxGeometry, BufferAttribute, type BufferGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Metre-based box-projection UVs (v16): every merged part gets the same texel density instead of each box face
 * stretching the whole texture. Per triangle, the dominant normal axis picks the projection plane.
 * `brush`: U follows the part's longest axis where it lies in the plane (brushing runs along rails / posts) and each
 * part gets a random offset (no visible repeats between neighbours). Without `brush`, V is always world height
 * (vertical faces), so painted textures keep their grime-towards-the-floor gradient.
 */
let uvSeed = 1
export function metalUV(g: BufferGeometry, tile: number, brush: boolean, yOff = 0): BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g
  if (geo !== g) g.dispose()
  const pos = geo.getAttribute('position')
  geo.computeBoundingBox()
  const s = geo.boundingBox!.getSize(new Vector3())
  const long = s.x >= s.y && s.x >= s.z ? 0 : s.y >= s.z ? 1 : 2
  const h = (uvSeed = (Math.imul(uvSeed, 1103515245) + 12345) | 0) >>> 0
  const ou = brush ? (h & 1023) / 1024 : (h & 1023) / 1024 * 0.37, ov = brush ? ((h >>> 10) & 1023) / 1024 : 0
  const uv = new Float32Array(pos.count * 2)
  const p = [0, 0, 0]
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i)
    const e1x = pos.getX(i + 1) - ax, e1y = pos.getY(i + 1) - ay, e1z = pos.getZ(i + 1) - az
    const e2x = pos.getX(i + 2) - ax, e2y = pos.getY(i + 2) - ay, e2z = pos.getZ(i + 2) - az
    const nx = Math.abs(e1y * e2z - e1z * e2y), ny = Math.abs(e1z * e2x - e1x * e2z), nz = Math.abs(e1x * e2y - e1y * e2x)
    let pu: number, pv: number
    if (nx >= ny && nx >= nz) { pu = 2; pv = 1 } else if (ny >= nz) { pu = 0; pv = 2 } else { pu = 0; pv = 1 }
    if (brush && pv === long) { pv = pu; pu = long }
    for (let k = 0; k < 3; k++) {
      p[0] = pos.getX(i + k); p[1] = pos.getY(i + k) + yOff; p[2] = pos.getZ(i + k)
      uv[(i + k) * 2] = p[pu] / tile + ou
      uv[(i + k) * 2 + 1] = p[pv] / tile + ov
    }
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2))
  return geo
}

export class Builder {
  parts: BufferGeometry[] = []
  /** `tile` (m): metre-based box-projected UVs (see metalUV); omit to keep the primitives' own UVs */
  constructor(private tile = 0, private brush = true, private yOff = 0) {}
  add(g: BufferGeometry, m: Matrix4 = new Matrix4()) {
    let geo = g.index ? g.toNonIndexed() : g
    geo.applyMatrix4(m)
    if (this.tile) { const p = geo; geo = metalUV(geo, this.tile, this.brush, this.yOff); if (p !== geo && p !== g) p.dispose() }
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2))
    if (geo !== g) g.dispose()
    this.parts.push(geo)
    return this
  }
  build() {
    const m = mergeGeometries(this.parts, false)!
    this.parts.forEach((g) => g.dispose())
    m.computeBoundingSphere()
    return m
  }
}
export const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(rx, ry, rz)), new Vector3(1, 1, 1))
export const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d)
export const rbox = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 2, r)
export const cyl = (rt: number, rb: number, h: number, seg = 12) => new CylinderGeometry(rt, rb, h, seg, 1)
