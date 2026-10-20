/** small helpers to build merged static/decor geometry (one draw per material) */
import { BoxGeometry, BufferAttribute, type BufferGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export class Builder {
  parts: BufferGeometry[] = []
  add(g: BufferGeometry, m: Matrix4 = new Matrix4()) {
    const geo = g.index ? g.toNonIndexed() : g
    geo.applyMatrix4(m)
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
