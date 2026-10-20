import { Interactable } from '@xrift/world-components'
import { RigidBody } from '@react-three/rapier'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CatmullRomCurve3, Group, MeshBasicMaterial, MeshStandardMaterial, PointLight, Points, ShaderMaterial,
  SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three'
import { beat } from '../../techno/beat'
import { club } from '../../techno/club'
import { useConcrete } from '.'
import { allocHalo, envOn, setHalo } from './fx'
import { ClubFloor } from './Fx'
import { VolumeFader } from './VolumeFader'
import { box, Builder, cyl, rbox, T } from './geo'
import { brickNormal, brickTexture, concreteNormal, hazeNoise, radialTexture, steelColor, steelNormal, steelRM, brushedRoughness } from './textures'

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
/** volume fader centre height (hand height) */
const FADER_Y = 1.3
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

function Box({ p, s, color = '#8a8a8a', map, nmap, collide = true, rough = 0.95, metal = 0 }: {
  p: [number, number, number]; s: [number, number, number]; color?: string; map?: import('three').Texture; nmap?: import('three').Texture; collide?: boolean; rough?: number; metal?: number
}) {
  const m = (
    <mesh position={p}>
      <boxGeometry args={s} />
      <meshStandardMaterial map={map} normalMap={nmap ?? (map ? brickN(map) : undefined)} color={color} roughness={rough} metalness={metal} />
    </mesh>
  )
  return collide ? <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>{m}</RigidBody> : m
}

// ================================================================ v13 geometry (door-local: origin bottom centre, front = +z)
const SKIN_D = 0.05
const rivet = () => new SphereGeometry(0.009, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2)

/** sliding door leaf → steel (skin, frame channels, ribs), hardware (rivets, pull bar, lock box, hangers, rollers), rubber (kick plate, sweep) */
function doorGeometry() {
  const steel = new Builder(), hw = new Builder(), rubber = new Builder()
  const W = PANEL_W, H = PANEL_H, f = SKIN_D / 2
  steel.add(box(W, H, SKIN_D), T(0, H / 2, 0))
  // perimeter channel (stiles + rails) and 3 hat-section ribs
  const ch = 0.075, cd = 0.03
  for (const sx of [-1, 1]) steel.add(rbox(ch, H, cd, 0.008), T(sx * (W / 2 - ch / 2), H / 2, f + cd / 2 - 0.004))
  for (const y of [ch / 2 + 0.24, H - ch / 2]) steel.add(rbox(W - 2 * ch + 0.01, ch, cd, 0.008), T(0, y, f + cd / 2 - 0.004))
  const ribs = [0.78, 1.3, 1.82]
  for (const y of ribs) { steel.add(rbox(W - 2 * ch, 0.07, 0.024, 0.008), T(0, y, f + 0.01)); steel.add(box(W - 2 * ch, 0.035, 0.01), T(0, y, f + 0.024)) }
  // vertical mid rib (two panels)
  steel.add(rbox(0.05, H - 0.24 - 2 * ch, 0.02, 0.006), T(0.12, (H + 0.24) / 2, f + 0.008))
  // rivets: along the stiles / rails / rib ends
  for (const sx of [-1, 1]) for (let y = 0.3; y < H - 0.05; y += 0.12) hw.add(rivet(), T(sx * (W / 2 - ch / 2), y, f + cd - 0.004, Math.PI / 2))
  for (const y of [ch / 2 + 0.24, H - ch / 2]) for (let x = -W / 2 + ch + 0.08; x < W / 2 - ch - 0.04; x += 0.13) hw.add(rivet(), T(x, y, f + cd - 0.004, Math.PI / 2))
  for (const y of ribs) for (const x of [-W / 2 + ch + 0.04, W / 2 - ch - 0.04, 0.12 - 0.05, 0.12 + 0.05]) hw.add(rivet(), T(x, y, f + 0.029, Math.PI / 2))
  // pull bar on flanged standoffs (left edge, the door slides to +x) + lock box + hasp
  const px = -W / 2 + 0.17
  hw.add(cyl(0.017, 0.017, 0.62, 12), T(px, 1.08, f + 0.085))
  for (const y of [0.82, 1.34]) {
    hw.add(cyl(0.012, 0.014, 0.075, 8), T(px, y, f + 0.045, Math.PI / 2))
    hw.add(cyl(0.028, 0.028, 0.008, 12), T(px, y, f + 0.006, Math.PI / 2))
    for (const a of [0, 2.1, 4.2]) hw.add(rivet(), T(px + Math.cos(a) * 0.02, y + Math.sin(a) * 0.02, f + 0.01, Math.PI / 2))
  }
  hw.add(rbox(0.1, 0.16, 0.045, 0.008), T(px + 0.02, 1.48, f + 0.022))
  hw.add(cyl(0.012, 0.012, 0.01, 10), T(px + 0.02, 1.46, f + 0.047, Math.PI / 2))
  hw.add(box(0.018, 0.008, 0.012), T(px + 0.02, 1.5, f + 0.048))
  // hangers: plates bolted to the top of the leaf rising to the rollers in the track
  for (const x of [-W / 2 + 0.22, W / 2 - 0.22]) {
    hw.add(box(0.12, 0.2, 0.012), T(x, H + 0.04, f + 0.012))
    for (const dx of [-0.035, 0.035]) for (const dy of [-0.03, -0.075]) hw.add(cyl(0.008, 0.008, 0.012, 6), T(x + dx, H + dy, f + 0.022, Math.PI / 2))
    hw.add(cyl(0.05, 0.05, 0.035, 18), T(x, H + 0.13, f + 0.04, Math.PI / 2))
    hw.add(cyl(0.012, 0.012, 0.06, 8), T(x, H + 0.13, f + 0.04, Math.PI / 2))
  }
  // rubber kick plate + floor sweep
  rubber.add(box(W - 0.02, 0.24, 0.01), T(0, 0.13, f + 0.004))
  rubber.add(box(W, 0.03, 0.035), T(0, 0.015, 0.005))
  for (let x = -W / 2 + 0.08; x < W / 2; x += 0.18) hw.add(rivet(), T(x, 0.22, f + 0.009, Math.PI / 2))
  return { steel: steel.build(), hw: hw.build(), rubber: rubber.build() }
}

/** static steel frame (bevelled jambs / head / track rail) + bolts, brackets, end stops, threshold (corridor side of the doorway) */
function frameGeometry(z0: number) {
  const steel = new Builder(), hw = new Builder()
  const zf = z0 + 0.04
  for (const sx of [-1, 1]) {
    steel.add(rbox(0.13, DOOR_H + 0.12, 0.08, 0.012), T(sx * (DOOR_W / 2 + 0.065), (DOOR_H + 0.12) / 2, zf))
    for (let y = 0.25; y < DOOR_H; y += 0.5) hw.add(cyl(0.013, 0.013, 0.012, 6), T(sx * (DOOR_W / 2 + 0.065), y, zf + 0.044, Math.PI / 2))
  }
  steel.add(rbox(DOOR_W + 0.26, 0.13, 0.08, 0.012), T(0, DOOR_H + 0.065, zf))
  // track: C-channel rail on wall brackets, runs over the open position (+x)
  const rl = PANEL_W * 2 + 0.5, rx = PANEL_W / 2 + 0.12, ry = PANEL_H + 0.2, rz = z0 + 0.15
  steel.add(rbox(rl, 0.1, 0.07, 0.01), T(rx, ry, rz))
  steel.add(box(rl, 0.012, 0.09), T(rx, ry - 0.05, rz))
  for (let x = rx - rl / 2 + 0.12; x < rx + rl / 2; x += 0.55) {
    hw.add(box(0.08, 0.16, 0.12), T(x, ry + 0.02, z0 + 0.07))
    for (const dy of [-0.04, 0.06]) hw.add(cyl(0.011, 0.011, 0.015, 6), T(x, ry + dy, z0 + 0.135, Math.PI / 2))
  }
  for (const x of [rx - rl / 2, rx + rl / 2]) hw.add(box(0.03, 0.13, 0.1), T(x, ry, rz))
  // floor guide + threshold plate
  hw.add(box(DOOR_W + 0.3, 0.008, 0.18), T(0, 0.004, z0 + 0.09))
  hw.add(box(0.05, 0.05, 0.05), T(PANEL_W / 2 + 0.06, 0.025, z0 + 0.2))
  return { steel: steel.build(), hw: hw.build() }
}

/** corridor details in dark painted metal: conduits + clamps, drain pipe, fuse box + its conduit, vent, cables, lamp fixture (bracket, socket, cage) */
function corridorGeometry(z0: number, z1: number, width: number, height: number, lamp: Vector3, pilot: Vector3) {
  const g = new Builder()
  const tube = (pts: [number, number, number][], r: number, seg = 32) => g.add(new TubeGeometry(new CatmullRomCurve3(pts.map((p) => new Vector3(...p))), seg, r, 6, false))
  const L = z1 - z0, zc = (z0 + z1) / 2
  // ceiling conduits (two sizes) with clamps
  g.add(cyl(0.022, 0.022, L, 8), T(-width / 2 + 0.14, height - 0.06, zc, Math.PI / 2))
  g.add(cyl(0.04, 0.04, L, 10), T(width / 2 - 0.22, height - 0.1, zc, Math.PI / 2))
  for (let z = z0 + 0.3; z < z1; z += 0.6) {
    g.add(box(0.07, 0.012, 0.03), T(-width / 2 + 0.14, height - 0.035, z))
    g.add(new TorusGeometry(0.043, 0.006, 4, 12, Math.PI), T(width / 2 - 0.22, height - 0.1, z, 0, 0, 0))
    g.add(box(0.012, 0.06, 0.03), T(width / 2 - 0.22, height - 0.03, z))
  }
  // lamp feed: conduit from the ceiling run, along the wall above the frame, into the lamp back box
  tube([[-width / 2 + 0.14, height - 0.06, z0 + 0.3], [-width / 2 + 0.16, height - 0.07, z0 + 0.06], [-0.4, height - 0.07, z0 + 0.03], [-0.08, lamp.y + 0.05, z0 + 0.03]], 0.011)
  tube([[-0.08, lamp.y + 0.03, z0 + 0.03], [pilot.x + 0.05, lamp.y + 0.02, z0 + 0.03], [pilot.x, pilot.y + 0.3, z0 + 0.03], [pilot.x, pilot.y + 0.04, z0 + 0.03]], 0.006, 16)
  // lamp fixture: back box, arm, socket, cage (rings + meridians)
  g.add(rbox(0.16, 0.11, 0.05, 0.01), T(lamp.x, lamp.y + 0.04, z0 + 0.025))
  g.add(cyl(0.014, 0.014, lamp.z - z0 - 0.04, 8), T(lamp.x, lamp.y + 0.05, (z0 + 0.04 + lamp.z) / 2, Math.PI / 2))
  g.add(cyl(0.01, 0.01, 0.06, 6), T(lamp.x, lamp.y + 0.025, lamp.z)) // drop to the socket
  g.add(cyl(0.026, 0.022, 0.04, 12), T(lamp.x, lamp.y + 0.01, lamp.z))
  g.add(cyl(0.03, 0.03, 0.008, 12), T(lamp.x, lamp.y + 0.008, lamp.z))
  for (const [y, r] of [[0.0, 0.05], [-0.045, 0.058], [-0.09, 0.042]] as const) g.add(new TorusGeometry(r, 0.0028, 4, 18), T(lamp.x, lamp.y + y, lamp.z, Math.PI / 2))
  for (let k = 0; k < 6; k++) g.add(new TorusGeometry(0.058, 0.0028, 4, 12, Math.PI), T(lamp.x, lamp.y - 0.045, lamp.z, 0, (k / 6) * Math.PI, Math.PI / 2))
  // pilot lamp housing
  g.add(rbox(0.07, 0.07, 0.04, 0.008), T(pilot.x, pilot.y, z0 + 0.02))
  g.add(new TorusGeometry(0.02, 0.004, 4, 14), T(pilot.x, pilot.y, z0 + 0.042))
  // fuse box on the left wall + conduit to the ceiling + cable down to the floor
  const fx = -width / 2 + 0.07, fz = z0 + 1.35
  g.add(rbox(0.12, 0.5, 0.38, 0.012), T(fx, 1.45, fz))
  g.add(box(0.008, 0.46, 0.34), T(fx + 0.062, 1.45, fz))
  for (const dz of [-0.15, 0.15]) g.add(cyl(0.008, 0.008, 0.08, 6), T(fx + 0.066, 1.45 + (dz > 0 ? 0.18 : -0.18), fz - 0.17))
  g.add(box(0.02, 0.05, 0.03), T(fx + 0.07, 1.45, fz + 0.15))
  g.add(cyl(0.018, 0.018, height - 1.7, 8), T(fx - 0.02, 1.7 + (height - 1.7) / 2, fz - 0.1))
  tube([[fx, 1.2, fz + 0.08], [fx - 0.03, 0.6, fz + 0.12], [-width / 2 + 0.02, 0.02, fz + 0.3], [-width / 2 + 0.03, 0.012, z0 + 0.25], [-DOOR_W / 2 - 0.12, 0.012, z0 + 0.09]], 0.008, 40)
  tube([[fx, 1.22, fz - 0.05], [fx - 0.035, 0.7, fz - 0.1], [-width / 2 + 0.025, 0.25, fz - 0.4], [-width / 2 + 0.03, 0.01, fz - 0.7]], 0.006, 24)
  // vent high on the right wall (frame + slats)
  const vx = width / 2 - 0.015, vz = z0 + 2.45, vy = 2.05
  g.add(box(0.02, 0.28, 0.44), T(vx, vy, vz))
  for (let k = 0; k < 6; k++) g.add(box(0.035, 0.012, 0.4), T(vx - 0.018, vy - 0.1 + k * 0.04, vz, 0, 0, 0.6))
  // vertical drain pipe by the door (right) with brackets + elbow at the floor
  const dx = width / 2 - 0.08, dz = z0 + 0.42
  g.add(cyl(0.035, 0.035, height - 0.12, 10), T(dx, height / 2 + 0.04, dz))
  for (const y of [0.5, 1.4, 2.2]) g.add(box(0.06, 0.03, 0.09), T(dx + 0.03, y, dz))
  g.add(new TorusGeometry(0.06, 0.035, 8, 10, Math.PI / 2), T(dx - 0.06, 0.1, dz, 0, 0, Math.PI))
  return g.build()
}

// ---- warm dust / haze shaders
const HAZE_VERT = /* glsl */ `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`
const HAZE_FRAG = /* glsl */ `
uniform sampler2D uNoise; uniform float uTime; uniform float uI; uniform vec3 uLamp; uniform vec3 uCol;
varying vec3 vW;
void main() {
  float n = texture2D(uNoise, vW.xz * 0.35 + vec2(uTime * 0.01, uTime * 0.006)).r * 0.65 + texture2D(uNoise, vW.xz * 0.9 - vec2(uTime * 0.02, 0.0)).g * 0.35;
  vec3 o = vW - uLamp; o.y *= 2.0;
  float fall = exp(-dot(o, o) * 1.1);
  float d = length(cameraPosition - vW);
  gl_FragColor = vec4(uCol * uI * fall * smoothstep(0.25, 0.85, n) * smoothstep(0.2, 1.0, d), 1.0);
}`
const DUST_VERT = /* glsl */ `
attribute float aSeed; uniform float uTime; uniform float uKick; uniform vec3 uLamp; uniform float uPx;
varying float vA;
void main() {
  vec3 p = position;
  float t = uTime * (0.04 + 0.03 * fract(aSeed * 7.3));
  p.x += sin(t * 6.2832 + aSeed * 11.0) * 0.12;
  p.z += cos(t * 5.1 + aSeed * 5.0) * 0.1;
  p.y = mod(p.y - t * 0.35 + uKick * 0.004 * fract(aSeed * 3.1), 1.6) + 0.75;
  vec3 o = p - uLamp; o.y *= 0.7;
  vA = exp(-dot(o, o) * 1.6) * (0.5 + 0.5 * sin(uTime * 1.3 + aSeed * 40.0)) + uKick * 0.25 * exp(-dot(o, o));
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_PointSize = uPx * (0.004 + 0.003 * fract(aSeed * 13.0)) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`
const DUST_FRAG = /* glsl */ `
uniform vec3 uCol; varying float vA;
void main() { vec2 q = gl_PointCoord - 0.5; float a = exp(-dot(q, q) * 14.0); gl_FragColor = vec4(uCol * a * vA * 0.5, 1.0); }`

const WARM = { r: 1.0, g: 0.74, b: 0.45 } // ~2700 K tungsten
const hashT = (a: number, b: number) => { let x = (a * 374761393 + b * 668265263) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296 }

export const Entrance: React.FC<EntranceProps> = ({ zMax, wall, roomWidth, roomHeight, length = 3.6, width = 1.9, height = 2.55 }) => {
  const z0 = zMax + wall // corridor starts at the outer face of the back wall
  const z1 = z0 + length
  const zc = (z0 + z1) / 2
  const sideW = (roomWidth - DOOR_W) / 2
  const brickSide = useBrick(sideW, roomHeight)
  const brickLintel = useBrick(DOOR_W, roomHeight - DOOR_H)
  const brickCorr = useBrick(length, height)
  const brickEnd = useBrick(width, height)
  const ceilMap = useConcrete(1.5)
  const ceilN = useMemo(() => { const t = concreteNormal().clone(); t.repeat.set(1.5, 1.5); t.needsUpdate = true; return t }, [])
  const radial = useMemo(() => radialTexture(), [])

  const lampPos = useMemo(() => new Vector3(0, DOOR_H + 0.3, z0 + 0.32), [z0])
  const pilotPos = useMemo(() => new Vector3(-0.87, 2.05, z0 + 0.05), [z0])
  const door = useMemo(() => doorGeometry(), [])
  const frame = useMemo(() => frameGeometry(z0), [z0])
  const details = useMemo(() => corridorGeometry(z0, z1, width, height, lampPos, pilotPos), [z0, z1, width, height, lampPos, pilotPos])

  const mats = useMemo(() => {
    const steel = new MeshStandardMaterial({ map: steelColor(), roughnessMap: steelRM(), metalnessMap: steelRM(), normalMap: steelNormal(), roughness: 1, metalness: 1, color: '#c8c8c8' })
    steel.normalScale.set(0.8, 0.8)
    const frameSteel = steel.clone(); frameSteel.color.set('#8a8a8a')
    const hw = new MeshStandardMaterial({ color: '#6b6e73', metalness: 0.9, roughness: 1, roughnessMap: brushedRoughness() })
    const rubber = new MeshStandardMaterial({ color: '#0c0c0c', roughness: 0.92, metalness: 0 })
    const paint = new MeshStandardMaterial({ color: '#202225', roughness: 0.6, metalness: 0.55 })
    return { steel, frameSteel, hw, rubber, paint }
  }, [])
  useEffect(() => {
    envOn(mats.steel, 0.55, true); envOn(mats.frameSteel, 0.45, true); envOn(mats.hw, 0.9, true); envOn(mats.paint, 0.5, true)
  }, [mats])

  const hazeMat = useMemo(() => new ShaderMaterial({
    vertexShader: HAZE_VERT, fragmentShader: HAZE_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    uniforms: { uNoise: { value: hazeNoise() }, uTime: { value: 0 }, uI: { value: 0.12 }, uLamp: { value: new Vector3() }, uCol: { value: [WARM.r, WARM.g, WARM.b] } },
  }), [lampPos])
  const dust = useMemo(() => {
    const n = 70
    const pos = new Float32Array(n * 3), seed = new Float32Array(n)
    let s = 5; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) | 0) >>> 0) / 4294967296
    for (let i = 0; i < n; i++) { pos.set([(rnd() - 0.5) * 1.4, rnd() * 1.6, z0 + 0.2 + rnd() * 1.2], i * 3); seed[i] = rnd() }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3)); g.setAttribute('aSeed', new BufferAttribute(seed, 1))
    g.computeBoundingSphere()
    const m = new ShaderMaterial({
      vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uKick: { value: 0 }, uLamp: { value: lampPos }, uPx: { value: 700 }, uCol: { value: [WARM.r, WARM.g * 0.95, WARM.b * 0.9] } },
    })
    return { g, m }
  }, [z0, lampPos])
  const halos = useMemo(() => ({ bulb: allocHalo('door.bulb'), wide: allocHalo('door.bulbWide'), pilot: allocHalo('door.pilot') }), [])

  const group = useRef<Group>(null)
  const slide = useRef<Group>(null)
  const bulb = useRef<MeshBasicMaterial>(null)
  const pilot = useRef<MeshBasicMaterial>(null)
  const light = useRef<PointLight>(null)
  const dustRef = useRef<Points>(null)
  const [solid, setSolid] = useState(true)
  const opening = useRef(false)
  const nearFor = useRef(0)
  const age = useRef(0)
  const wpos = useMemo(() => new Vector3(), [])

  const open = () => {
    if (opening.current) return
    opening.current = true
    club.entered = true
    setSolid(false)
  }

  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__openDoor = open

  useFrame(({ camera, gl }, delta) => {
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
    // muffled kicks behind the closed door: the leaf rattles a hair in its track (≈1.5 mm), dust jumps a little
    const thump = (club.audio ? beat.kickHit * beat.kickHit : 0) * (1 - d) * club.outside
    if (slide.current) {
      slide.current.position.x = e * (PANEL_W + 0.25) + 0.0012 * thump * Math.sin(performance.now() * 0.09)
      slide.current.position.z = -0.0015 * thump
    }
    // tungsten bulb: warm, faint mains shimmer + rare tiny sags (never brighter than its base level → no flashing)
    const tt = performance.now() / 1000
    const sag = hashT(Math.floor(tt * 9), 3) < 0.02 ? 0.82 : 1
    const fl = (0.975 + 0.012 * Math.sin(tt * 2.1) + 0.008 * Math.sin(tt * 7.3 + 1.1) + 0.005 * Math.sin(tt * 31)) * sag
    if (bulb.current) bulb.current.color.setRGB(WARM.r, WARM.g, WARM.b).multiplyScalar(0.95 * fl)
    if (light.current) light.current.intensity = 1.35 * fl
    const pl = opening.current ? 0.25 : 0.75
    if (pilot.current) pilot.current.color.setRGB(0.8, 0.05, 0.06).multiplyScalar(pl)
    if (group.current) {
      group.current.localToWorld(wpos.copy(lampPos).add(tmp.set(0, -0.045, 0)))
      setHalo(halos.bulb, wpos, null, 0.32, 0.55 * fl, WARM.r, WARM.g, WARM.b)
      ;(hazeMat.uniforms.uLamp.value as Vector3).copy(wpos)
      setHalo(halos.wide, wpos, null, 1.0, 0.09 * fl, WARM.r, WARM.g * 0.9, WARM.b * 0.8)
      group.current.localToWorld(wpos.copy(pilotPos).add(tmp.set(0, 0, 0.03)))
      setHalo(halos.pilot, wpos, null, 0.11, 0.7 * pl, 0.85, 0.06, 0.07)
    }
    hazeMat.uniforms.uTime.value = tt
    hazeMat.uniforms.uI.value = 0.13 * fl * (0.4 + 0.6 * club.outside)
    dust.m.uniforms.uTime.value = tt
    dust.m.uniforms.uKick.value = thump
    dust.m.uniforms.uPx.value = gl.domElement.height * 1.2
  })

  const yTop = DOOR_H + (roomHeight - DOOR_H) / 2
  return (
    <group ref={group}>
      {/* club back wall with the doorway cut out (brick) */}
      <Box p={[-(DOOR_W / 2 + sideW / 2), roomHeight / 2, zMax + wall / 2]} s={[sideW, roomHeight, wall]} map={brickSide} color="#9a9a9a" />
      <Box p={[DOOR_W / 2 + sideW / 2, roomHeight / 2, zMax + wall / 2]} s={[sideW, roomHeight, wall]} map={brickSide} color="#9a9a9a" />
      <Box p={[0, yTop, zMax + wall / 2]} s={[DOOR_W, roomHeight - DOOR_H, wall]} map={brickLintel} color="#9a9a9a" />

      {/* corridor: damp concrete floor (patchy roughness, faint glints), low concrete ceiling, brick walls, dead end */}
      <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
        <ClubFloor width={width} depth={length} zc={zc} color="#4e4e4e" repeat={2} env={0.12} always />
      </RigidBody>
      <Box p={[0, height + 0.05, zc]} s={[width + 0.6, 0.1, length]} map={ceilMap} nmap={ceilN} color="#3a3a3a" />
      <Box p={[-(width / 2 + 0.15), height / 2, zc]} s={[0.3, height, length]} map={brickCorr} color="#7a7a7a" rough={0.86} />
      <Box p={[width / 2 + 0.15, height / 2, zc]} s={[0.3, height, length]} map={brickCorr} color="#7a7a7a" rough={0.86} />
      <Box p={[0, height / 2, z1 + 0.15]} s={[width + 0.6, height, 0.3]} map={brickEnd} color="#7a7a7a" rough={0.86} />
      {/* conduits, drain pipe, fuse box, vent, cables, lamp fixture (one merged mesh) */}
      <mesh geometry={details} material={mats.paint} />

      {/* steel frame + track rail (static) */}
      <mesh geometry={frame.steel} material={mats.frameSteel} />
      <mesh geometry={frame.hw} material={mats.hw} />

      {/* the door: heavy sliding steel leaf (skin, channels, ribs, rivets, pull bar, lock box, hangers / rollers, rubber kick plate) */}
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
              <mesh geometry={door.steel} material={mats.steel} />
              <mesh geometry={door.hw} material={mats.hw} />
              <mesh geometry={door.rubber} material={mats.rubber} />
            </group>
          </Interactable>
        </group>
      </group>

      {/* per-user volume faders (same level both sides): club side left of the doorway on the back wall, and in the
          corridor on the left wall next to the door (by the fuse box) */}
      <VolumeFader id="vol-in" position={[-(DOOR_W / 2 + 0.45), FADER_Y, zMax]} rotationY={Math.PI} conduit={roomHeight - FADER_Y - 0.17}
        mats={{ steel: mats.frameSteel, hw: mats.hw, rubber: mats.rubber, paint: mats.paint }} accept={(c) => c.z < zMax + wall / 2} />
      <VolumeFader id="vol-out" position={[-width / 2, FADER_Y, z0 + 0.7]} rotationY={Math.PI / 2} conduit={height - FADER_Y - 0.17}
        mats={{ steel: mats.frameSteel, hw: mats.hw, rubber: mats.rubber, paint: mats.paint }} accept={(c) => c.z > z0 - 0.05} />

      {/* caged tungsten bulb + red pilot lamp (emissive cores; halos in the shared HaloField) */}
      <mesh position={[lampPos.x, lampPos.y - 0.045, lampPos.z]}>
        <sphereGeometry args={[0.03, 14, 10]} />
        <meshBasicMaterial ref={bulb} color="#000000" toneMapped={false} />
      </mesh>
      <mesh position={[pilotPos.x, pilotPos.y, pilotPos.z]}>
        <sphereGeometry args={[0.016, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial ref={pilot} color="#000000" toneMapped={false} />
      </mesh>
      {/* soft warm wash on the lintel brick around the lamp (fake falloff / bounce) */}
      <mesh position={[0, lampPos.y - 0.08, z0 + 0.003]}>
        <planeGeometry args={[1.8, 1.1]} />
        <meshBasicMaterial map={radial} color="#251a12" transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* the one real light in the corridor: warm, short range, no shadows */}
      <pointLight ref={light} position={[lampPos.x, lampPos.y - 0.12, lampPos.z + 0.3]} color="#ffbf80" intensity={1.35} distance={5} decay={2} />
      {/* faint warm haze under the ceiling + drifting dust in the bulb light */}
      <mesh position={[0, height - 0.28, z0 + 1.0]} rotation={[-Math.PI / 2, 0, 0]} material={hazeMat} renderOrder={4}>
        <planeGeometry args={[width - 0.05, 2.0]} />
      </mesh>
      <points ref={dustRef} geometry={dust.g} material={dust.m} frustumCulled={false} renderOrder={5} />
    </group>
  )
}
