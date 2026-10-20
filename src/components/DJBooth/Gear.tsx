/**
 * v12 DJ booth: scuffed black flight-case table with aluminium edge extrusions / ball corners / latches,
 * 2 CDJ-style players (spinning jogs, subtle ring LEDs, dim abstract waveform screens), a 4-channel mixer
 * (knob rows, faders, audio-driven VU LEDs), laptop on a stand, headphones, booth monitors, cables.
 * Everything is merged / instanced (≈11 draw calls). No text anywhere.
 * Booth-local frame: table top at y = 1.0, the DJ stands at −z and faces +z; devices face the DJ.
 */
import { useFrame } from '@react-three/fiber'
import { RigidBody } from '@react-three/rapier'
import { useEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry, BufferAttribute, type BufferGeometry, CatmullRomCurve3, Color, CylinderGeometry, Euler, InstancedMesh, Matrix4,
  Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, RingGeometry, ShaderMaterial, SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { beat } from '../../techno/beat'
import { envOn } from '../Club/fx'
import { brushedRoughness, caseNormal, caseRoughness } from '../Club/textures'

const TOP = 1.0
const DEV_Z = -0.2
/** device placement: booth-local position + yaw; device frame has the user at +z' → rotate by π to face the DJ (−z) */
const place = (x: number, z: number, yaw = 0, y = TOP) => new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(0, Math.PI + yaw, 0)), new Vector3(1, 1, 1))
const CDJ_X = [-0.4, 0.4]
const DECKS = CDJ_X.map((x) => place(x, DEV_Z))
const MIXER = place(0, DEV_Z)
const LAPTOP = place(0.98, -0.1, -0.25)
const PHONES = place(-0.88, -0.12, 0.5)

class Builder {
  parts: BufferGeometry[] = []
  extra: Record<string, number[]> = {}
  add(g: BufferGeometry, local: Matrix4, dev?: Matrix4, attrs?: Record<string, number[]>) {
    const m = dev ? dev.clone().multiply(local) : local
    let geo = g.index ? g.toNonIndexed() : g
    geo.applyMatrix4(m)
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2))
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      const n = geo.getAttribute('position').count
      const arr = new Float32Array(n * v.length)
      for (let i = 0; i < n; i++) arr.set(v, i * v.length)
      geo.setAttribute(k, new BufferAttribute(arr, v.length))
    }
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
const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) => new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(rx, ry, rz)), new Vector3(s, s, s))
const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d)
const rbox = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 2, r)
const cyl = (rt: number, rb: number, h: number, seg = 16) => new CylinderGeometry(rt, rb, h, seg, 1)

// --- screen layout (device frame) ---
const CDJ_SCREEN = { y: 0.094, z: -0.1215, tilt: 0.42, w: 0.15, h: 0.088 }

function buildGear() {
  const body = new Builder() // satin black plastics / cabinets / cables
  const metal = new Builder() // brushed aluminium: case hardware, bezels, plates, slots
  const screens = new Builder() // aSeed
  const rings = new Builder() // aDeck + aCenter
  const knobs: Matrix4[] = []
  const faders: Matrix4[] = []
  const leds: { m: Matrix4; kind: number; a: number; b: number }[] = [] // kind 0 VU(ch,idx) 1 play 2 cue 3 pad(deck,idx)

  // ======================= flight case hardware (table 3.6 × 1 × 1.2 centred at y 0.5)
  const W = 3.6, H = 1.0, D = 1.2, e = 0.018
  for (const y of [e / 2 + 0.002, H - e / 2]) for (const z of [-D / 2, D / 2]) metal.add(box(W - 0.06, 0.036, 0.036), T(0, y, z))
  for (const y of [e / 2 + 0.002, H - e / 2]) for (const x of [-W / 2, W / 2]) metal.add(box(0.036, 0.036, D - 0.06), T(x, y, 0))
  for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) metal.add(box(0.036, H - 0.06, 0.036), T(x, H / 2, z))
  for (const x of [-W / 2, W / 2]) for (const y of [0.025, H - 0.025]) for (const z of [-D / 2, D / 2]) {
    metal.add(new SphereGeometry(0.042, 10, 8), T(x, y, z)) // ball corners
  }
  // butterfly latches + recessed handles on the visible faces; lid seam band
  for (const z of [-D / 2 - 0.004, D / 2 + 0.004]) {
    for (const x of [-1.25, -0.42, 0.42, 1.25]) {
      metal.add(box(0.1, 0.07, 0.012), T(x, 0.83, z))
      metal.add(cyl(0.022, 0.022, 0.014, 12), T(x, 0.83, z + Math.sign(z) * 0.006, Math.PI / 2))
    }
    metal.add(box(W - 0.1, 0.022, 0.008), T(0, 0.78, z))
  }
  for (const x of [-W / 2 - 0.004, W / 2 + 0.004]) {
    metal.add(box(0.01, 0.1, 0.24), T(x, 0.62, 0))
    metal.add(box(0.008, 0.022, D - 0.1), T(x, 0.78, 0))
  }
  // castor plates + wheels (hidden mostly, but the silhouette reads)
  for (const x of [-1.6, 1.6]) for (const z of [-0.45, 0.45]) body.add(cyl(0.035, 0.035, 0.03, 10), T(x, 0.035, z, 0, 0, Math.PI / 2))

  // ======================= CDJ ×2
  DECKS.forEach((D4, d) => {
    body.add(rbox(0.32, 0.065, 0.42, 0.01), T(0, 0.0325, 0), D4)
    // screen housing (raised wedge at the rear)
    body.add(rbox(0.21, 0.04, 0.12, 0.008), T(0, 0.075, -0.13, CDJ_SCREEN.tilt), D4)
    screens.add(new PlaneGeometry(CDJ_SCREEN.w, CDJ_SCREEN.h), T(0, CDJ_SCREEN.y, CDJ_SCREEN.z, CDJ_SCREEN.tilt - Math.PI / 2), D4, { aSeed: [d] })
    // jog: aluminium bezel + ring LED (platter itself spins separately)
    metal.add(new TorusGeometry(0.11, 0.008, 6, 40), T(0, 0.068, 0.06, Math.PI / 2), D4)
    metal.add(cyl(0.115, 0.118, 0.006, 40), T(0, 0.066, 0.06), D4)
    const ring = new RingGeometry(0.099, 0.104, 48, 1)
    rings.add(ring, T(0, 0.0705, 0.06, -Math.PI / 2), D4, { aDeck: [d] })
    // play / cue
    leds.push({ m: D4.clone().multiply(T(-0.125, 0.067, 0.17, 0, 0, 0, 1)).multiply(new Matrix4().makeScale(3.5, 1, 3.5)), kind: 1, a: d, b: 0 })
    leds.push({ m: D4.clone().multiply(T(-0.125, 0.067, 0.125)).multiply(new Matrix4().makeScale(3.5, 1, 3.5)), kind: 2, a: d, b: 0 })
    // hot-cue pads row
    for (let k = 0; k < 8; k++) leds.push({ m: D4.clone().multiply(T(-0.105 + k * 0.03, 0.067, -0.045)).multiply(new Matrix4().makeScale(3.4, 1, 2.6)), kind: 3, a: d, b: k })
    // tempo slot + fader cap, pitch buttons, browse knob, small buttons row
    metal.add(box(0.008, 0.002, 0.13), T(0.135, 0.066, 0.07), D4)
    faders.push(D4.clone().multiply(T(0.135, 0.071, 0.06 + 0.03 * (d ? -1 : 1))))
    knobs.push(D4.clone().multiply(T(0.13, 0.072, -0.12)))
    for (let k = 0; k < 4; k++) body.add(box(0.018, 0.006, 0.012), T(-0.13, 0.068, -0.12 + k * 0.022), D4)
    for (let k = 0; k < 3; k++) body.add(box(0.02, 0.006, 0.012), T(0.13, 0.068, 0.15 + k * -0.0), D4)
    body.add(box(0.03, 0.006, 0.016), T(0.125, 0.068, 0.17), D4)
  })

  // ======================= mixer (4 ch)
  body.add(rbox(0.3, 0.085, 0.42, 0.01), T(0, 0.0425, 0), MIXER)
  metal.add(box(0.282, 0.002, 0.4), T(0, 0.0855, 0), MIXER)
  const chX = [-0.09, -0.03, 0.03, 0.09]
  chX.forEach((x, c) => {
    for (let r = 0; r < 5; r++) knobs.push(MIXER.clone().multiply(T(x, 0.093, -0.17 + r * 0.04)))
    // VU column (12 LEDs) beside the knob column: bottom (index 0) nearest the DJ
    for (let k = 0; k < 12; k++) leds.push({ m: MIXER.clone().multiply(T(x + 0.022, 0.0865, 0.06 - k * 0.0068)).multiply(new Matrix4().makeScale(1, 1, 0.9)), kind: 0, a: c, b: k })
    body.add(box(0.006, 0.003, 0.075), T(x, 0.0862, 0.115), MIXER) // fader slot
    faders.push(MIXER.clone().multiply(T(x, 0.094, 0.13 - [0.05, 0.02, 0.06, 0.035][c])))
  })
  for (let k = 0; k < 12; k++) for (const s of [0, 1]) leds.push({ m: MIXER.clone().multiply(T(0.128 + s * 0.008, 0.0865, -0.1 - k * 0.0068)), kind: 0, a: 4 + s, b: k })
  body.add(box(0.1, 0.003, 0.006), T(0, 0.0862, 0.18), MIXER)
  faders.push(MIXER.clone().multiply(T(0.012, 0.094, 0.18, 0, Math.PI / 2)))
  knobs.push(MIXER.clone().multiply(T(0.132, 0.093, 0.02)), MIXER.clone().multiply(T(0.132, 0.093, 0.06)), MIXER.clone().multiply(T(-0.128, 0.093, 0.02)))

  // ======================= laptop on a stand
  metal.add(box(0.012, 0.11, 0.2), T(-0.12, 0.055, 0, 0.0), LAPTOP).add(box(0.012, 0.11, 0.2), T(0.12, 0.055, 0), LAPTOP)
  const L = LAPTOP.clone().multiply(T(0, 0.12, 0, 0.18))
  metal.add(box(0.31, 0.012, 0.215), T(0, 0, 0), L)
  body.add(box(0.27, 0.002, 0.1), T(0, 0.0065, 0.02), L) // keyboard well
  const lid = L.clone().multiply(T(0, 0.006, -0.107, -0.22)).multiply(T(0, 0.105, 0)) // hinge at the rear, opened ~100°
  metal.add(box(0.31, 0.21, 0.007), T(0, 0, 0), lid)
  screens.add(new PlaneGeometry(0.28, 0.175), T(0, 0.004, 0.0036), lid, { aSeed: [2] })

  // ======================= headphones (resting on the table)
  const band = new TorusGeometry(0.085, 0.011, 6, 20, Math.PI)
  body.add(band, T(0, 0.03, 0, -Math.PI / 2 + 0.25), PHONES)
  for (const s of [-1, 1]) {
    body.add(cyl(0.045, 0.045, 0.035, 18), T(s * 0.085, 0.02, 0.0, 0, 0, Math.PI / 2 + s * 0.15), PHONES)
    metal.add(cyl(0.032, 0.032, 0.002, 16), T(s * 0.104, 0.023, 0, 0, 0, Math.PI / 2 + s * 0.15), PHONES)
  }

  // ======================= booth monitors (face the DJ), on the table ends
  for (const s of [-1, 1]) {
    const M = place(s * 1.52, -0.15, -s * 0.45).multiply(T(0, 0.16, 0, -0.12))
    body.add(rbox(0.3, 0.32, 0.3, 0.02), T(0, 0, 0), M)
    body.add(cyl(0.1, 0.075, 0.03, 20), T(0, -0.03, 0.15, Math.PI / 2), M) // woofer cone (recessed)
    metal.add(new TorusGeometry(0.104, 0.007, 6, 24), T(0, -0.03, 0.152), M)
    body.add(cyl(0.025, 0.02, 0.02, 12), T(0, 0.1, 0.152, Math.PI / 2), M)
    metal.add(new TorusGeometry(0.03, 0.004, 5, 16), T(0, 0.1, 0.153), M)
    body.add(box(0.28, 0.02, 0.26), T(0, -0.17, 0), M) // isolation pad
  }

  // ======================= cables (tubes): device rears → grommet holes; headphones → mixer; power down the side
  const tube = (pts: [number, number, number][], r = 0.006) => body.add(new TubeGeometry(new CatmullRomCurve3(pts.map((p) => new Vector3(...p))), 24, r, 5, false), new Matrix4())
  for (const x of [-0.4, 0.0, 0.4]) tube([[x + 0.05, TOP + 0.03, DEV_Z + 0.22], [x + 0.06, TOP + 0.012, DEV_Z + 0.3], [x * 0.5 + 0.1, TOP + 0.006, 0.18], [0.12, TOP - 0.02, 0.26]])
  for (const x of [-0.4, 0.0, 0.4]) tube([[x - 0.06, TOP + 0.03, DEV_Z + 0.22], [x - 0.05, TOP + 0.01, DEV_Z + 0.32], [x * 0.7 - 0.12, TOP + 0.006, 0.22], [-0.16, TOP - 0.02, 0.28]], 0.005)
  tube([[0.95, TOP + 0.12, 0.0], [0.9, TOP + 0.02, 0.12], [0.6, TOP + 0.006, 0.2], [0.14, TOP - 0.02, 0.27]], 0.004)
  tube([[-0.88, TOP + 0.03, -0.12], [-0.7, TOP + 0.006, -0.36], [-0.3, TOP + 0.006, -0.45], [-0.06, TOP + 0.03, -0.42]], 0.0035)
  tube([[1.72, TOP + 0.005, -0.3], [1.84, TOP - 0.05, -0.36], [1.86, 0.5, -0.4], [1.95, 0.03, -0.25], [2.4, 0.01, 0.1]], 0.009)
  tube([[-1.72, TOP + 0.005, -0.25], [-1.84, TOP - 0.06, -0.3], [-1.85, 0.4, -0.45], [-2.1, 0.01, -0.6]], 0.009)
  for (const x of [0.12, -0.16]) body.add(cyl(0.03, 0.03, 0.004, 14), T(x, TOP + 0.001, x > 0 ? 0.26 : 0.28)) // grommets

  return {
    body: body.build(), metal: metal.build(), screens: screens.build(), rings: rings.build(), knobs, faders, leds,
  }
}

const RING_VERT = /* glsl */ `
attribute float aDeck;
varying vec3 vP;
varying float vDeck;
void main() { vP = position; vDeck = aDeck; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const RING_FRAG = /* glsl */ `
uniform vec2 uC0;
uniform vec2 uC1;
uniform vec2 uAng;
uniform float uKick;
uniform float uLit;
varying vec3 vP;
varying float vDeck;
void main() {
  vec2 c = vDeck < 0.5 ? uC0 : uC1;
  float a = atan(vP.z - c.y, vP.x - c.x);
  float ang = vDeck < 0.5 ? uAng.x : uAng.y;
  float d = abs(mod(a - ang + 3.14159265, 6.2831853) - 3.14159265);
  float marker = exp(-d * d * 30.0);
  vec3 col = vec3(0.87, 0.91, 1.0) * (0.06 + 0.55 * marker) + vec3(0.77, 0.06, 0.11) * uKick * 0.6;
  gl_FragColor = vec4(col * uLit, 1.0);
}`
const SCREEN_VERT = /* glsl */ `
attribute float aSeed;
varying vec2 vUv;
varying float vSeed;
void main() { vUv = uv; vSeed = aSeed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const SCREEN_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uKick;
uniform float uLit;
uniform float uLevel;
varying vec2 vUv;
varying float vSeed;
float h1(float x) { return fract(sin(x * 127.1 + vSeed * 311.7) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
/** abstract waveform column height at (scrolling) position x, beats at integer x */
float wave(float x) {
  float b = fract(x);
  float kick = exp(-b * 9.0);
  float hat = exp(-abs(fract(x * 2.0) - 0.5) * 22.0) * 0.35;
  return clamp(0.18 + 0.55 * kick + hat + 0.3 * n1(x * 6.0) - 0.1 * step(0.97, n1(x * 0.21)), 0.04, 1.0);
}
void main() {
  vec3 bg = vec3(0.012, 0.014, 0.02);
  vec3 col = bg;
  vec3 white = vec3(0.8, 0.85, 0.95);
  vec3 red = vec3(0.77, 0.06, 0.11);
  vec2 uv = vUv;
  if (vSeed < 1.5) {
    // CDJ: scrolling zoomed waveform (top), overview strip (bottom), red playhead
    float beats = 6.0;
    if (uv.y > 0.38) {
      float cols = 96.0;
      float cx = (floor(uv.x * cols) + 0.5) / cols;
      float x = (cx - 0.35) * beats + uBeat + vSeed * 3.0;
      float hgt = wave(x) * 0.27;
      float yc = 0.68;
      float on = step(abs(uv.y - yc), hgt) * step(0.25, fract(uv.x * cols));
      float past = step(cx, 0.35);
      col += on * mix(white * 0.55, white * 0.3, past);
      col += red * 0.9 * (1.0 - smoothstep(0.0, 0.006, abs(uv.x - 0.35)));
      col += white * 0.15 * step(0.985, fract(x)) ; // beat grid ticks
    } else if (uv.y > 0.08 && uv.y < 0.3) {
      float cols = 140.0;
      float cx = floor(uv.x * cols) / cols;
      float env = 0.25 + 0.75 * n1(cx * 9.0 + vSeed * 5.0) * smoothstep(0.0, 0.1, cx) * (1.0 - smoothstep(0.9, 1.0, cx));
      float on = step(abs(uv.y - 0.19), env * 0.1);
      float prog = fract(uTime / 420.0 + vSeed * 0.37);
      col += on * mix(white * 0.12, white * 0.32, step(cx, prog));
      col += red * 0.8 * (1.0 - smoothstep(0.0, 0.004, abs(uv.x - prog)));
    }
    col += red * 0.05 * uKick;
  } else {
    // laptop: 4 stacked lanes of thin waveforms + an abstract list (dim bars, no text)
    if (uv.x > 0.3) {
      float lane = floor(uv.y * 4.0);
      float ly = fract(uv.y * 4.0);
      float cols = 160.0;
      float cx = floor(uv.x * cols) / cols;
      float x = cx * 10.0 + uBeat * (lane == 3.0 ? 1.0 : 0.0) + lane * 7.0;
      float hgt = wave(x) * 0.3 * (lane == 3.0 ? 1.0 : 0.6);
      col += step(abs(ly - 0.5), hgt) * step(0.06, ly) * step(ly, 0.94) * white * (lane == 3.0 ? 0.35 : 0.14);
      col += white * 0.05 * step(ly, 0.03);
    } else {
      float row = floor(uv.y * 14.0);
      float ry = fract(uv.y * 14.0);
      float len = 0.4 + 0.5 * h1(row * 3.1);
      float sel = step(abs(row - 9.0), 0.5);
      col += white * (0.07 + 0.1 * sel) * step(0.3, ry) * step(ry, 0.7) * step(uv.x / 0.3, len) * step(0.06, uv.x / 0.3);
      col += red * 0.12 * sel * step(uv.x, 0.012);
    }
    col += white * 0.04 * step(abs(uv.x - 0.3), 0.002);
  }
  // display grain / slight vignetting
  col *= 0.9 + 0.1 * smoothstep(0.0, 0.15, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  gl_FragColor = vec4(col * uLit, 1.0);
}`

const COLD = new Color(0.87, 0.91, 1.0)
const RED = new Color(0.77, 0.06, 0.11)
const tmp = new Color()

export const BoothGear: React.FC<{ panelRef: React.RefObject<MeshStandardMaterial | null> }> = ({ panelRef }) => {
  const g = useMemo(() => buildGear(), [])
  const caseMat = useMemo(() => {
    const r = caseRoughness().clone(); r.repeat.set(3, 1); r.needsUpdate = true
    const n = caseNormal().clone(); n.repeat.set(3, 1); n.needsUpdate = true
    const m = new MeshStandardMaterial({ color: '#141414', roughness: 1, roughnessMap: r, normalMap: n, metalness: 0.15 })
    m.normalScale.set(0.35, 0.35)
    return m
  }, [])
  const caseGeo = useMemo(() => new RoundedBoxGeometry(3.6, 1, 1.2, 3, 0.03), [])
  const metalMat = useMemo(() => new MeshStandardMaterial({ color: '#8d9096', metalness: 0.92, roughness: 1, roughnessMap: brushedRoughness() }), [])
  const bodyMat = useMemo(() => new MeshStandardMaterial({ color: '#111113', metalness: 0.25, roughness: 0.48 }), [])
  const jogMat = useMemo(() => new MeshStandardMaterial({ color: '#1a1b1e', metalness: 0.7, roughness: 0.3 }), [])
  const capMat = useMemo(() => new MeshStandardMaterial({ color: '#2b2c30', metalness: 0.45, roughness: 0.4 }), [])
  useEffect(() => { envOn(caseMat, 0.35); envOn(metalMat, 1.6); envOn(bodyMat, 0.6); envOn(jogMat, 1.0); envOn(capMat, 0.7) }, [caseMat, metalMat, bodyMat, jogMat, capMat])

  const jogGeo = useMemo(() => {
    const b = new Builder()
    b.add(cyl(0.097, 0.099, 0.012, 40), T(0, 0, 0))
    b.add(cyl(0.036, 0.036, 0.004, 24), T(0, 0.007, 0))
    for (let k = 0; k < 3; k++) b.add(new TorusGeometry(0.06 + k * 0.012, 0.0016, 3, 40), T(0, 0.006, 0, Math.PI / 2))
    b.add(box(0.006, 0.003, 0.03), T(0, 0.0085, 0.06)) // position marker
    return b.build()
  }, [])
  const jogs = useRef<(Mesh | null)[]>([])
  const jogPos = useMemo(() => DECKS.map((D4) => new Vector3(0, 0.074, 0.06).applyMatrix4(D4)), [])

  const ringMat = useMemo(() => new ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: RING_FRAG, toneMapped: false,
    uniforms: { uC0: { value: [jogPos[0].x, jogPos[0].z] }, uC1: { value: [jogPos[1].x, jogPos[1].z] }, uAng: { value: [0, 0] }, uKick: { value: 0 }, uLit: { value: 0 } },
  }), [jogPos])
  const screenMat = useMemo(() => new ShaderMaterial({
    vertexShader: SCREEN_VERT, fragmentShader: SCREEN_FRAG, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uBeat: { value: 0 }, uKick: { value: 0 }, uLit: { value: 0 }, uLevel: { value: 0 } },
  }), [])

  const knobGeo = useMemo(() => {
    const b = new Builder()
    b.add(cyl(0.0095, 0.011, 0.014, 14), T(0, 0, 0))
    b.add(box(0.0018, 0.0012, 0.008), T(0, 0.0072, -0.004))
    return b.build()
  }, [])
  const faderGeo = useMemo(() => {
    const b = new Builder()
    b.add(rbox(0.016, 0.012, 0.024, 0.003), T(0, 0, 0))
    b.add(box(0.017, 0.0015, 0.002), T(0, 0.0062, 0))
    return b.build()
  }, [])
  const ledGeo = useMemo(() => new BoxGeometry(0.0055, 0.002, 0.0042), [])
  const ledMesh = useRef<InstancedMesh | null>(null)
  const vu = useRef(new Float32Array(6))
  const baseLed = useMemo(() => g.leds.map((l) => (l.kind === 0 ? (l.b >= 10 ? RED : COLD) : l.kind === 3 ? COLD : l.kind === 2 ? RED : COLD)), [g])
  const instInit = (mats: Matrix4[]) => (m: InstancedMesh | null) => { if (m) { mats.forEach((M, i) => m.setMatrixAt(i, M)); m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere() } }

  useFrame((_, delta) => {
    const lit = beat.lit
    const kick = beat.kickHit * beat.kickHit
    // jogs spin while playing (33⅓-ish feel, tied to the tempo)
    const spin = beat.active ? delta * (beat.bpm / 60) * 1.4 : 0
    jogs.current.forEach((j, i) => { if (j) j.rotation.y -= spin * (i ? 1.0 : 0.97) })
    const ang = ringMat.uniforms.uAng.value as number[]
    // ring marker angle (booth frame) follows the platter rotation; the device frame is rotated by π
    for (let i = 0; i < 2; i++) { const th = jogs.current[i]?.rotation.y ?? 0; ang[i] = Math.atan2(Math.cos(th), Math.sin(th)) }
    ringMat.uniforms.uKick.value = kick * (1 - beat.preDrop)
    ringMat.uniforms.uLit.value = lit
    screenMat.uniforms.uTime.value = beat.time
    screenMat.uniforms.uBeat.value = beat.step / 4 // advances with the heard 16ths
    screenMat.uniforms.uKick.value = kick
    screenMat.uniforms.uLit.value = lit * 0.85
    // VU meters: channel c ← 4 analyser bands; masters ← full mix
    const L = beat.levels
    const kv = Math.exp(-delta * 7)
    for (let c = 0; c < 6; c++) {
      let a = 0
      if (c < 4) { for (let k = 0; k < 4; k++) a += L[c * 4 + k] ?? 0; a /= 4 } else { for (let k = 0; k < 16; k++) a += L[k] ?? 0; a = a / 16 * (c === 4 ? 1.05 : 0.98) }
      a = Math.min(1, Math.pow(a, 0.75) * 1.25)
      vu.current[c] = Math.max(a, vu.current[c] * kv)
    }
    const m = ledMesh.current
    if (!m) return
    g.leds.forEach((l, i) => {
      let v = 0.04
      if (l.kind === 0) v = vu.current[l.a] * 12 > l.b ? (l.b >= 10 ? 0.95 : 0.65) : 0.035
      else if (l.kind === 1) v = beat.active ? 0.35 + 0.35 * (beat.step % 4 < 2 ? 1 : 0.4) : 0.06 // play: steady blink with the beat
      else if (l.kind === 2) v = 0.25
      else if (l.kind === 3) v = (beat.step % 8) === l.b && l.a === (Math.floor(beat.step / 32) % 2) ? 0.5 : 0.06
      m.setColorAt(i, tmp.copy(baseLed[i]).multiplyScalar(v * lit))
    })
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  })

  return (
    <group>
      {/* flight-case table (collider) */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[0, 0.5, 0]} material={caseMat} geometry={caseGeo} />
      </RigidBody>
      <mesh geometry={g.metal} material={metalMat} />
      <mesh geometry={g.body} material={bodyMat} />
      {/* thin deep-red line (kick ambience) on the crowd side of the case */}
      <mesh position={[0, 0.5, 0.612]}>
        <planeGeometry args={[3.3, 0.03]} />
        <meshStandardMaterial ref={panelRef} color="#0b0b0b" emissive="#c4101c" emissiveIntensity={0} />
      </mesh>
      {jogPos.map((p, i) => (
        <mesh key={i} ref={(j) => { jogs.current[i] = j }} position={p} geometry={jogGeo} material={jogMat} />
      ))}
      <mesh geometry={g.rings} material={ringMat} />
      <mesh geometry={g.screens} material={screenMat} />
      <instancedMesh ref={instInit(g.knobs)} args={[knobGeo, capMat, g.knobs.length]} />
      <instancedMesh ref={instInit(g.faders)} args={[faderGeo, capMat, g.faders.length]} />
      <instancedMesh ref={(m) => {
        ledMesh.current = m
        if (m && !m.instanceColor) { g.leds.forEach((l, i) => { m.setMatrixAt(i, l.m); m.setColorAt(i, tmp.set(0, 0, 0)) }); m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere() }
      }} args={[ledGeo, undefined, g.leds.length]}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  )
}
