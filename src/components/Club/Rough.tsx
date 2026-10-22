/**
 * v19 "lived-in" pass: grime decals (multiply), paint patches + tape, loose cables with sag, sparse clutter
 * (flightcases, a crate, a coiled cable). Deterministic (seeded) and merged per material:
 *   grime (1 draw) · paint / light tape (1) · black rubber: cables + gaffer tape + crate + coil (1) · case laminate (1) ·
 *   case hardware (1). Clutter that can be bumped into gets a fixed collider (starting 0.1 m above the floor so the
 *   player's feet sensor never brushes it, see Bounds.tsx).
 */
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { useEffect, useMemo } from 'react'
import {
  BufferAttribute, CatmullRomCurve3, Matrix4, MeshBasicMaterial, MeshStandardMaterial, MultiplyBlending, PlaneGeometry,
  SphereGeometry, TorusGeometry, TubeGeometry, Vector3, type BufferGeometry,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { envOn } from './fx'
import { Builder, box, cyl, rbox, T } from './geo'
import { BRUSH_TILE, caseNormal, caseRoughness, grimeAtlas } from './textures'
import { brushedMetal } from './metal'

const hh = (a: number, b: number) => {
  let x = (a * 374761393 + b * 668265263) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}
const FOOT = 0.1

// ---------------------------------------------------------------- decals
/** cells of the grime atlas */
export const enum G { Damp = 0, Drip = 1, Stain = 2, Patch = 3 }
/** a decal quad: centre p, surface normal n (pointing into the room), in-plane "up" u, size w × h, atlas cell, mirror */
function decal(b: Builder, p: Vector3, n: Vector3, u: Vector3, w: number, h: number, cell: number, mirror = false) {
  const g = new PlaneGeometry(w, h)
  const uv = g.getAttribute('uv') as BufferAttribute
  const cx = cell % 2, cy = Math.floor(cell / 2), e = 0.004
  for (let i = 0; i < uv.count; i++) {
    let x = uv.getX(i)
    if (mirror) x = 1 - x
    uv.setXY(i, (cx + e + x * (1 - 2 * e)) / 2, (cy + e + uv.getY(i) * (1 - 2 * e)) / 2)
  }
  const xAxis = new Vector3().crossVectors(u, n).normalize()
  const m = new Matrix4().makeBasis(xAxis, u.clone().normalize(), n.clone().normalize()).setPosition(p.clone().addScaledVector(n, 0.006))
  b.add(g, m)
}
const grimeMat = () => new MeshBasicMaterial({
  // toneMapped off + sRGB atlas: the colorspace encode undoes the decode, so the framebuffer is multiplied by the atlas value as stored
  map: grimeAtlas(), blending: MultiplyBlending, premultipliedAlpha: true, transparent: true, depthWrite: false, fog: false, toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
})

/** a box room's walls / floor / ceiling: seeded damp along the skirting, drips, patches, floor stains */
interface Wall { o: Vector3; along: Vector3; n: Vector3; len: number; skip?: [number, number][] }
function roomGrime(b: Builder, walls: Wall[], height: number, floor: { x0: number; x1: number; z0: number; z1: number; n: number }, seed: number) {
  const up = new Vector3(0, 1, 0)
  walls.forEach((W, wi) => {
    // damp along the floor: uneven runs, not everywhere
    let s = 0.2 + hh(wi, seed) * 0.8
    let k = 0
    while (s < W.len - 0.4) {
      const w = 0.7 + hh(wi * 31 + k, seed + 1) * 1.8
      const c = s + w / 2
      if (!W.skip?.some(([a, z]) => c > a && c < z) && hh(wi * 31 + k, seed + 2) < 0.72) {
        const h = 0.45 + hh(wi * 31 + k, seed + 3) * 0.75
        decal(b, W.o.clone().addScaledVector(W.along, c).add(new Vector3(0, h / 2, 0)), W.n, up, w, h, G.Damp, hh(k, wi) < 0.5)
      }
      s += w * (0.75 + hh(wi * 31 + k, seed + 4) * 0.9)
      k++
    }
    // run-off drips from the ceiling / pipes
    const nd = Math.round(W.len / 3.2)
    for (let j = 0; j < nd; j++) {
      const c = (j + 0.2 + hh(wi * 17 + j, seed + 5) * 0.6) * (W.len / nd)
      if (W.skip?.some(([a, z]) => c > a && c < z)) continue
      const h = 0.7 + hh(wi * 17 + j, seed + 6) * 1.0, w = 0.5 + hh(wi * 17 + j, seed + 7) * 0.7
      decal(b, W.o.clone().addScaledVector(W.along, c).add(new Vector3(0, height - h / 2, 0)), W.n, up, w, h, G.Drip, hh(j, wi + 9) < 0.5)
    }
    // mid-wall grime / soot patches
    const np = Math.round(W.len / 2.6)
    for (let j = 0; j < np; j++) {
      const c = hh(wi * 13 + j, seed + 8) * W.len
      if (W.skip?.some(([a, z]) => c > a - 0.4 && c < z + 0.4)) continue
      const sz = 0.5 + hh(wi * 13 + j, seed + 9) * 1.1
      decal(b, W.o.clone().addScaledVector(W.along, c).add(new Vector3(0, 0.9 + hh(wi * 13 + j, seed + 10) * (height - 1.6), 0)), W.n, up, sz * 1.3, sz, G.Patch)
    }
  })
  // floor stains: spills / oil / wear, random rotation
  for (let j = 0; j < floor.n; j++) {
    const x = floor.x0 + hh(j, seed + 11) * (floor.x1 - floor.x0), z = floor.z0 + hh(j, seed + 12) * (floor.z1 - floor.z0)
    const sz = 0.35 + hh(j, seed + 13) ** 2 * 1.4
    const a = hh(j, seed + 14) * Math.PI * 2
    decal(b, new Vector3(x, 0.0, z), up, new Vector3(Math.sin(a), 0, Math.cos(a)), sz * (0.8 + 0.5 * hh(j, seed + 15)), sz, j % 3 === 2 ? G.Patch : G.Stain)
  }
}

// ---------------------------------------------------------------- cables
function cable(b: Builder, pts: [number, number, number][], r = 0.007, seg = 48) {
  b.add(new TubeGeometry(new CatmullRomCurve3(pts.map((p) => new Vector3(...p)), false, 'catmullrom', 0.4), seg, r, 6, false))
}
/** floor run: wandering path on the floor (a few cm of slack between the waypoints), y = r */
function floorCable(b: Builder, pts: [number, number][], seed: number, r = 0.008) {
  const out: [number, number, number][] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1]
    const L = Math.hypot(x1 - x0, z1 - z0), nx = -(z1 - z0) / L, nz = (x1 - x0) / L
    const steps = Math.max(2, Math.round(L / 0.5))
    for (let k = 0; k < steps; k++) {
      const t = k / steps, w = (hh(seed * 97 + i * 13 + k, 3) - 0.5) * 0.14 * Math.sin(Math.PI * t + 0.3)
      out.push([x0 + (x1 - x0) * t + nx * w, r, z0 + (z1 - z0) * t + nz * w])
    }
  }
  const [xl, zl] = pts[pts.length - 1]
  out.push([xl, r, zl])
  cable(b, out, r, Math.max(24, out.length * 5))
  return out
}
/** gaffer tape strip over a floor cable at waypoint p (slightly crooked) */
function tape(b: Builder, x: number, z: number, ang: number, len = 0.32, w = 0.05) {
  const g = new PlaneGeometry(w, len)
  g.rotateX(-Math.PI / 2)
  b.add(g, T(x, 0.0035 + 0.0175, z, 0, ang))
}
/** hanging cable between two points with a catenary-ish sag */
function sagCable(b: Builder, A: Vector3, B: Vector3, sag: number, r = 0.008) {
  const pts: [number, number, number][] = []
  for (let k = 0; k <= 8; k++) { const t = k / 8; const p = A.clone().lerp(B, t); pts.push([p.x, p.y - sag * 4 * t * (1 - t), p.z]) }
  cable(b, pts, r, 40)
}

// ---------------------------------------------------------------- clutter
interface Case { x: number; z: number; y?: number; w: number; h: number; d: number; yaw: number }
function flightcase(lam: Builder, hw: Builder, c: Case) {
  const y0 = c.y ?? 0
  const M = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => new Matrix4().makeRotationY(c.yaw).setPosition(c.x, y0, c.z).multiply(T(x, y, z, rx, ry, rz))
  lam.add(new RoundedBoxGeometry(c.w - 0.02, c.h - 0.02, c.d - 0.02, 2, 0.01), M(0, c.h / 2, 0))
  const e = 0.022
  // aluminium edge extrusions (12 edges) + ball corners
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) hw.add(box(c.w - 0.06, e, e), M(0, c.h / 2 + sy * (c.h / 2 - e / 2), sz * (c.d / 2 - e / 2)))
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) hw.add(box(e, c.h - 0.06, e), M(sx * (c.w / 2 - e / 2), c.h / 2, sz * (c.d / 2 - e / 2)))
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) hw.add(box(e, e, c.d - 0.06), M(sx * (c.w / 2 - e / 2), c.h / 2 + sy * (c.h / 2 - e / 2), 0))
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) hw.add(new SphereGeometry(0.03, 8, 6), M(sx * (c.w / 2 - 0.02), c.h / 2 + sy * (c.h / 2 - 0.02), sz * (c.d / 2 - 0.02)))
  // lid seam strip, two butterfly latches per long side, recessed handles on the ends
  const ly = c.h * 0.72
  for (const sz of [-1, 1]) {
    hw.add(box(c.w - 0.05, 0.016, 0.006), M(0, ly, sz * (c.d / 2 + 0.002)))
    for (const sx of [-1, 1]) { hw.add(rbox(0.07, 0.06, 0.014, 0.004), M(sx * c.w * 0.28, ly, sz * (c.d / 2 + 0.006))); hw.add(cyl(0.012, 0.012, 0.012, 10), M(sx * c.w * 0.28, ly - 0.012, sz * (c.d / 2 + 0.014), Math.PI / 2)) }
  }
  for (const sx of [-1, 1]) hw.add(rbox(0.012, 0.09, 0.16, 0.004), M(sx * (c.w / 2 + 0.004), c.h * 0.6, 0))
}

export interface ClubRoughProps { width: number; zMin: number; zMax: number; height: number }

/** club interior: grime, paint patches / tape, cables, clutter (rendered with the interior, see CullWhileClosed) */
export const ClubRough: React.FC<ClubRoughProps> = ({ width, zMin, zMax, height }) => {
  const hw2 = width / 2
  const { geo, cases } = useMemo(() => {
    const grime = new Builder(), paint = new Builder(), rubber = new Builder(), lam = new Builder(), hw = new Builder(BRUSH_TILE)
    // ---- grime on the four walls (door wall: skip the doorway and the fader), floor stains
    roomGrime(grime, [
      { o: new Vector3(-hw2, 0, zMin), along: new Vector3(0, 0, 1), n: new Vector3(1, 0, 0), len: zMax - zMin },
      { o: new Vector3(hw2, 0, zMax), along: new Vector3(0, 0, -1), n: new Vector3(-1, 0, 0), len: zMax - zMin },
      { o: new Vector3(hw2, 0, zMin), along: new Vector3(-1, 0, 0), n: new Vector3(0, 0, 1), len: width, skip: [] },
      { o: new Vector3(-hw2, 0, zMax), along: new Vector3(1, 0, 0), n: new Vector3(0, 0, -1), len: width, skip: [[hw2 - 1.35, hw2 + 0.8]] },
    ], height, { x0: -hw2 + 0.4, x1: hw2 - 0.4, z0: zMin + 0.4, z1: zMax - 0.4, n: 22 }, 7)
    // ceiling soot over the truss
    const down = new Vector3(0, -1, 0)
    for (let j = 0; j < 4; j++) decal(grime, new Vector3(-3.6 + j * 2.5 + (hh(j, 61) - 0.5), height - 0.002, zMin + 1.6 + (hh(j, 62) - 0.5) * 0.8), down, new Vector3(1, 0, 0), 1.4 + hh(j, 63), 1.0 + hh(j, 64) * 0.6, G.Patch)
    // ---- paint patches over the brick (where something was removed / patched up), slightly off-square
    const patches: [number, number, number, number, number, number][] = [
      // wall: 0 = left (x−), 1 = right (x+), 3 = door wall ; along, y, w, h, rot
      [0, 3.4, 1.35, 1.1, 0.75, 0.012], [0, 8.9, 0.95, 0.6, 0.9, -0.02], [1, 5.6, 1.7, 1.4, 0.5, 0.008], [1, 9.9, 0.7, 0.8, 1.2, 0.015], [3, 2.0, 1.25, 0.9, 1.1, -0.01],
    ]
    for (const [wi, a, y, w, h, r] of patches) {
      const g = new PlaneGeometry(w, h)
      if (wi === 0) paint.add(g, T(-hw2 + 0.005, y, zMin + a, 0, Math.PI / 2, r))
      else if (wi === 1) paint.add(g, T(hw2 - 0.005, y, zMax - a, 0, -Math.PI / 2, r))
      else paint.add(g, T(-hw2 + a, y, zMax - 0.005, 0, Math.PI, r))
      // the patch paint is dirty too (soot / hand marks), slightly larger than the patch so the edge isn't crisp
      const up = new Vector3(0, 1, 0), k = wi * 7 + a
      const [p, n] = wi === 0 ? [new Vector3(-hw2, y, zMin + a), new Vector3(1, 0, 0)] : wi === 1 ? [new Vector3(hw2, y, zMax - a), new Vector3(-1, 0, 0)] : [new Vector3(-hw2 + a, y, zMax), new Vector3(0, 0, -1)]
      decal(grime, p.add(new Vector3(0, (hh(k, 41) - 0.5) * 0.2, 0)), n, up, w * 1.25, h * 1.2, G.Patch, hh(k, 42) < 0.5)
    }
    // grey masking-tape marks on the floor around the booth (old stage marks, half peeled → broken runs)
    for (let k = 0; k < 9; k++) {
      const t = k / 9, x = -1.95 + t * 3.9 + (hh(k, 71) - 0.5) * 0.1
      if (hh(k, 72) < 0.3) continue
      const g = new PlaneGeometry(0.36 + hh(k, 73) * 0.2, 0.045); g.rotateX(-Math.PI / 2)
      paint.add(g, T(x, 0.003, 0.82 + (hh(k, 74) - 0.5) * 0.04, 0, (hh(k, 75) - 0.5) * 0.06))
    }
    // ---- cables: booth → PA stacks along the floor (slack, wandering), taped down where people walk
    const runs: [number, number][][] = [
      [[-1.75, -0.5], [-2.6, -0.95], [-3.6, -1.2], [-4.25, -1.25]],
      [[1.75, -0.45], [2.7, -0.85], [3.7, -1.35], [4.25, -1.3]],
      [[-1.7, 0.35], [-2.4, 1.2], [-3.3, 2.3], [-4.2, 2.85]],
      [[1.72, 0.3], [2.5, 1.35], [3.45, 2.2], [4.22, 2.95]],
      // power: along the right wall from the corner to the booth, a second loose run behind the booth
      [[4.85, 5.4], [4.86, 3.8], [4.7, 3.3], [4.3, 3.1]],
      [[-0.6, -0.62], [-0.2, -1.1], [0.5, -1.15], [1.2, -0.7]],
    ]
    runs.forEach((r, i) => {
      const pts = floorCable(rubber, r, i + 1, i >= 4 ? 0.011 : 0.008)
      if (i < 4) for (let k = 3; k < pts.length - 2; k += 4) {
        const [x, , z] = pts[k], [x2, , z2] = pts[k + 1]
        tape(rubber, x, z, Math.atan2(x2 - x, z2 - z) + Math.PI / 2 + (hh(i, k) - 0.5) * 0.3)
      }
    })
    // hanging: truss ends → side walls / ceiling, a drop from the truss centre to the ceiling (sagging)
    const ty = height - 0.55, tz = zMin + 1.6
    sagCable(rubber, new Vector3(-4.62, ty + 0.05, tz + 0.08), new Vector3(-hw2 + 0.04, height - 0.12, tz + 0.55), 0.22)
    sagCable(rubber, new Vector3(4.6, ty + 0.1, tz - 0.05), new Vector3(hw2 - 0.04, height - 0.25, tz - 0.4), 0.3)
    sagCable(rubber, new Vector3(0.35, ty + 0.15, tz + 0.1), new Vector3(1.6, height - 0.02, tz + 0.3), 0.18, 0.006)
    sagCable(rubber, new Vector3(-2.1, ty + 0.15, tz - 0.1), new Vector3(-2.8, height - 0.02, tz - 0.6), 0.14, 0.006)
    // ---- clutter (sparse, dark, against walls / corners, off the walking lines)
    const cs: Case[] = [
      { x: -4.4, z: 5.35, w: 1.0, h: 0.62, d: 0.6, yaw: 0.06 },
      { x: -4.35, z: 5.3, y: 0.62, w: 0.78, h: 0.44, d: 0.5, yaw: -0.13 },
      { x: 4.55, z: -2.75, w: 0.55, h: 0.95, d: 0.5, yaw: Math.PI / 2 + 0.09 },
      { x: -4.6, z: -4.55, w: 0.62, h: 0.5, d: 0.46, yaw: 0.35 },
    ]
    cs.forEach((c) => flightcase(lam, hw, c))
    // black plastic crate in the right front corner with a coil in it, a second coil on the floor by the booth
    const crate = (x: number, z: number, yaw: number) => {
      const M = (px: number, py: number, pz: number, ry = 0) => new Matrix4().makeRotationY(yaw).setPosition(x, 0, z).multiply(T(px, py, pz, 0, ry))
      const W = 0.5, Hc = 0.3, Dc = 0.36, t = 0.012
      rubber.add(box(W, t, Dc), M(0, 0.02, 0))
      for (const s of [-1, 1]) {
        for (let k = 0; k < 3; k++) rubber.add(box(W, 0.05, t), M(0, 0.05 + k * 0.1, s * (Dc / 2 - t / 2)))
        for (let k = 0; k < 3; k++) rubber.add(box(t, 0.05, Dc), M(s * (W / 2 - t / 2), 0.05 + k * 0.1, 0))
        for (const q of [-1, 1]) rubber.add(box(0.03, Hc, 0.03), M(s * (W / 2 - 0.015), Hc / 2, q * (Dc / 2 - 0.015)))
      }
      rubber.add(box(W + 0.01, 0.025, Dc + 0.01), M(0, Hc - 0.012, 0).multiply(new Matrix4().makeScale(1, 1, 1)))
      // (rim) — hollow look: the rim is a thin frame
    }
    crate(4.5, 5.45, -0.22)
    const coil = (x: number, y: number, z: number, R: number, n: number, seed: number) => {
      for (let k = 0; k < n; k++) {
        const g = new TorusGeometry(R + (hh(k, seed) - 0.5) * 0.03, 0.008, 6, 40)
        g.rotateX(Math.PI / 2)
        rubber.add(g, T(x + (hh(k, seed + 1) - 0.5) * 0.04, y + 0.008 + k * 0.014, z + (hh(k, seed + 2) - 0.5) * 0.04, (hh(k, seed + 3) - 0.5) * 0.08, 0, (hh(k, seed + 4) - 0.5) * 0.08))
      }
    }
    coil(4.5, 0.3, 5.45, 0.13, 4, 81)
    coil(2.12, 0, -0.95, 0.19, 6, 91)
    cable(rubber, [[2.12 + 0.19, 0.012, -0.95], [2.4, 0.01, -0.7], [2.55, 0.01, -0.35], [2.5, 0.01, -0.1]], 0.008, 24)
    return { geo: { grime: grime.build(), paint: paint.build(), rubber: rubber.build(), lam: lam.build(), hw: hw.build() }, cases: cs }
  }, [hw2, width, zMin, zMax, height])
  const mats = useMemo(() => {
    const r = caseRoughness().clone(); r.repeat.set(2, 1); r.needsUpdate = true
    const n = caseNormal().clone(); n.repeat.set(2, 1); n.needsUpdate = true
    const lam = new MeshStandardMaterial({ color: '#141414', roughness: 1, roughnessMap: r, normalMap: n, metalness: 0.15 })
    lam.normalScale.set(0.35, 0.35)
    return {
      grime: grimeMat(),
      paint: new MeshStandardMaterial({ color: '#3d3e40', metalness: 0.2, roughness: 0.92 }),
      rubber: new MeshStandardMaterial({ color: '#0d0d0e', metalness: 0.25, roughness: 0.6 }),
      lam,
      hw: brushedMetal('#6c6f74', 0.9),
    }
  }, [])
  useEffect(() => { envOn(mats.lam, 0.35); envOn(mats.paint, 0.3); envOn(mats.rubber, 0.5); envOn(mats.hw, 1.2, false, true) }, [mats])
  return (
    <group userData={{ rough: true }}>
      <mesh geometry={geo.grime} material={mats.grime} renderOrder={1} />
      <mesh geometry={geo.paint} material={mats.paint} />
      <mesh geometry={geo.rubber} material={mats.rubber} />
      <mesh geometry={geo.lam} material={mats.lam} />
      <mesh geometry={geo.hw} material={mats.hw} />
      <RigidBody type="fixed" colliders={false}>
        {cases.map((c, i) => {
          const top = (c.y ?? 0) + c.h
          const y0 = Math.max(FOOT, c.y ?? 0)
          return <CuboidCollider key={i} args={[c.w / 2, (top - y0) / 2, c.d / 2]} position={[c.x, (top + y0) / 2, c.z]} rotation={[0, c.yaw, 0]} />
        })}
        <CuboidCollider args={[0.25, 0.1, 0.18]} position={[4.5, 0.2 + 0.05, 5.45]} rotation={[0, -0.22, 0]} />
      </RigidBody>
    </group>
  )
}

/** corridor: grime on walls / end wall / floor (single merged decal mesh, same material type as the club's) */
export const CorridorRough: React.FC<{ z0: number; z1: number; width: number; height: number }> = ({ z0, z1, width, height }) => {
  const geo = useMemo(() => {
    const grime = new Builder(), rubber = new Builder()
    const w = width / 2
    // two overlapping seeded passes: the corridor is the first thing players see up close, so it's dirtier than the club walls
    for (const seed of [19, 23]) roomGrime(grime, [
      { o: new Vector3(-w, 0, z1), along: new Vector3(0, 0, -1), n: new Vector3(1, 0, 0), len: z1 - z0, skip: [[z1 - z0 - 0.95, z1 - z0 - 0.45]] },
      { o: new Vector3(w, 0, z0), along: new Vector3(0, 0, 1), n: new Vector3(-1, 0, 0), len: z1 - z0, skip: [[0.25, 0.6]] },
      { o: new Vector3(w, 0, z1), along: new Vector3(-1, 0, 0), n: new Vector3(0, 0, -1), len: width },
    ], height, { x0: -w + 0.2, x1: w - 0.2, z0: z0 + 0.4, z1: z1 - 0.2, n: 5 }, seed)
    // a loose coil and a cable along the skirting at the dead end
    floorCable(rubber, [[-w + 0.05, z1 - 0.1], [-w + 0.06, z1 - 1.2], [-w + 0.08, z1 - 2.2]], 7, 0.007)
    for (let k = 0; k < 4; k++) {
      const g = new TorusGeometry(0.15 + (hh(k, 5) - 0.5) * 0.03, 0.007, 6, 36); g.rotateX(Math.PI / 2)
      rubber.add(g, T(w - 0.3 + (hh(k, 6) - 0.5) * 0.03, 0.008 + k * 0.013, z1 - 0.32, (hh(k, 7) - 0.5) * 0.08, 0, (hh(k, 8) - 0.5) * 0.08))
    }
    return { grime: grime.build(), rubber: rubber.build() }
  }, [z0, z1, width, height])
  const mats = useMemo(() => ({ grime: grimeMat(), rubber: new MeshStandardMaterial({ color: '#0d0d0e', metalness: 0.25, roughness: 0.6 }) }), [])
  useEffect(() => { envOn(mats.rubber, 0.5, true) }, [mats])
  return (
    <group userData={{ rough: true }}>
      <mesh geometry={geo.grime} material={mats.grime} renderOrder={1} />
      <mesh geometry={geo.rubber} material={mats.rubber} />
    </group>
  )
}
export type { BufferGeometry }
