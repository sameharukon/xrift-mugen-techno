import { Interactable } from '@xrift/world-components'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { type Group, type Material, type Mesh, MeshBasicMaterial, Plane, Raycaster, Vector2, Vector3 } from 'three'
import { setVolume, volume } from '../../techno/volume'
import { allocHalo, setHalo } from './fx'
import { Builder, box, cyl, rbox, T } from './geo'

/**
 * Per-user volume fader: a small scuffed steel plate on a painted back box (conduit up to the ceiling),
 * a recessed slot with a black rubber fader cap, faint engraved ticks and a dim red level light-pipe.
 * No text. Findable in the dark only by the faint line on the cap.
 *
 * Interaction (XRift Interactable only passes an id, no hit point):
 *  - the slot is covered by STEPS invisible hit strips (one Interactable each) → pointing anywhere on the
 *    track sets that level, in VR (controller ray) as well as on desktop;
 *  - desktop: the exact point under the centre reticle is taken (continuous), and while the mouse button
 *    is held the fader follows the reticle (look up / down to drag).
 * `accept(local camera pos)` rejects hits through walls (the interactable raycast ignores occluders).
 */
const STEPS = 11
const TRAVEL = 0.2
const PW = 0.085, PH = 0.31
const HIT_H = TRAVEL / (STEPS - 1)
const hitMat = new MeshBasicMaterial({ visible: false })
const NDC0 = new Vector2(0, 0)
const rc = new Raycaster()
const plane = new Plane()
const _p = new Vector3(), _n = new Vector3(), _c = new Vector3()

function faderGeometry(conduit: number) {
  const steel = new Builder(), hw = new Builder(), dark = new Builder(), paint = new Builder()
  // painted back box + conduit up to the ceiling (+ a strap)
  paint.add(rbox(PW + 0.022, PH + 0.03, 0.03, 0.006), T(0, 0, 0.015))
  paint.add(cyl(0.011, 0.011, conduit, 8), T(0, PH / 2 + 0.015 + conduit / 2, 0.016))
  paint.add(box(0.035, 0.012, 0.03), T(0, PH / 2 + 0.2, 0.016))
  // cover plate (scuffed steel, rounded) + 4 screws
  steel.add(rbox(PW, PH, 0.008, 0.004), T(0, 0, 0.034))
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    hw.add(cyl(0.0055, 0.0055, 0.003, 10), T(sx * (PW / 2 - 0.011), sy * (PH / 2 - 0.012), 0.039, Math.PI / 2))
    hw.add(box(0.008, 0.0012, 0.0012), T(sx * (PW / 2 - 0.011), sy * (PH / 2 - 0.012), 0.0408, 0, 0, sx * sy * 0.6))
  }
  // recessed slot: dark gap, flanked by two pressed lips
  dark.add(box(0.007, TRAVEL + 0.02, 0.002), T(-0.008, 0, 0.0385))
  for (const sx of [-1, 1]) hw.add(box(0.0025, TRAVEL + 0.026, 0.0025), T(-0.008 + sx * 0.0055, 0, 0.0395))
  // engraved ticks (left of the slot), longer at 0 / 50 / 100 %
  for (let k = 0; k < STEPS; k++) {
    const long = k === 0 || k === 5 || k === STEPS - 1
    dark.add(box(long ? 0.012 : 0.007, 0.0012, 0.001), T(-0.026 - (long ? 0.0025 : 0), -TRAVEL / 2 + k * HIT_H, 0.0384))
  }
  // light-pipe slot (right of the fader slot)
  dark.add(box(0.0035, TRAVEL + 0.004, 0.0015), T(0.022, 0, 0.0384))
  // fader cap: rubber body with a centre groove + metal stem
  const cap = new Builder()
  cap.add(rbox(0.036, 0.02, 0.022, 0.004), T(0, 0, 0.011))
  cap.add(box(0.032, 0.003, 0.004), T(0, 0.0055, 0.022))
  cap.add(box(0.032, 0.003, 0.004), T(0, -0.0055, 0.022))
  const stem = new Builder().add(box(0.004, 0.006, 0.01), T(0, 0, -0.003))
  return { steel: steel.build(), hw: hw.build(), dark: dark.build(), paint: paint.build(), cap: cap.build(), stem: stem.build() }
}

export interface FaderMats { steel: Material; hw: Material; rubber: Material; paint: Material }

export const VolumeFader: React.FC<{
  id: string
  position: [number, number, number]
  rotationY: number
  /** distance from the plate top to the ceiling (conduit length) */
  conduit: number
  mats: FaderMats
  /** world-local camera position → may this side be operated (no hits through walls) */
  accept: (camLocal: Vector3) => boolean
}> = ({ id, position, rotationY, conduit, mats, accept }) => {
  const geo = useMemo(() => faderGeometry(conduit), [conduit])
  const root = useRef<Group>(null)
  const capRef = useRef<Group>(null)
  const pipe = useRef<Mesh>(null)
  const line = useMemo(() => new MeshBasicMaterial({ color: '#000000', toneMapped: false }), [])
  const pipeMat = useMemo(() => new MeshBasicMaterial({ color: '#000000', toneMapped: false }), [])
  const halo = useMemo(() => allocHalo(`fader.${id}`), [id])
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const st = useRef({ shown: volume.level, held: false, drag: false })

  // mouse button state (capture phase on window → runs before the interactable's own mousedown handler)
  useEffect(() => {
    const down = () => { st.current.held = true }
    const up = () => { st.current.held = false; st.current.drag = false }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('mouseup', up, true)
    window.addEventListener('blur', up)
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('mouseup', up, true); window.removeEventListener('blur', up) }
  }, [])

  const camLocal = (out: Vector3) => {
    camera.getWorldPosition(out)
    const parent = root.current?.parent
    if (parent) parent.worldToLocal(out)
    return out
  }
  /** level under the centre reticle (desktop), or null if the reticle is off the track */
  const reticleLevel = (slack: number): number | null => {
    const g = root.current
    if (!g) return null
    rc.setFromCamera(NDC0, camera)
    g.getWorldPosition(_p)
    _n.set(0, 0, 1).transformDirection(g.matrixWorld)
    plane.setFromNormalAndCoplanarPoint(_n, _p)
    if (!rc.ray.intersectPlane(plane, _c)) return null
    g.worldToLocal(_c)
    if (Math.abs(_c.x) > PW / 2 + slack || Math.abs(_c.y) > TRAVEL / 2 + HIT_H + slack) return null
    return Math.min(1, Math.max(0, (_c.y + TRAVEL / 2) / TRAVEL))
  }
  const onStep = (k: number) => {
    if (!accept(camLocal(_c))) return
    const xr = gl.xr.isPresenting
    const exact = xr ? null : reticleLevel(0.01)
    setVolume(exact ?? k / (STEPS - 1))
    if (!xr && st.current.held) st.current.drag = true
  }

  useFrame((_, delta) => {
    const S = st.current
    if (S.drag) {
      if (!S.held || gl.xr.isPresenting) S.drag = false
      else {
        const l = reticleLevel(0.12)
        if (l != null) setVolume(l)
      }
    }
    S.shown += (volume.level - S.shown) * Math.min(1, delta * 18)
    const y = -TRAVEL / 2 + S.shown * TRAVEL
    if (capRef.current) capRef.current.position.y = y
    if (pipe.current) {
      pipe.current.scale.y = Math.max(0.001, S.shown)
      pipe.current.position.y = -TRAVEL / 2 + (S.shown * TRAVEL) / 2
    }
    // faint cold line on the cap (findable in the dark), very dim deep-red level pipe
    const t = performance.now() / 1000
    const glow = 0.42 + 0.04 * Math.sin(t * 1.7)
    line.color.setRGB(0.62 * glow, 0.66 * glow, 0.72 * glow)
    pipeMat.color.setRGB(0.05, 0.003, 0.004)
    if (capRef.current) {
      capRef.current.getWorldPosition(_p)
      _n.set(0, 0, 0.03).transformDirection(capRef.current.matrixWorld).multiplyScalar(0.03)
      _p.add(_n)
      // only from this side of the wall, fading out at grazing angles (the billboard must not peek around the jamb)
      // camera position as last rendered (matrixWorld) → also right for XR / overridden cameras
      _c.setFromMatrixPosition(camera.matrixWorld)
      if (import.meta.env.DEV) { const o = (globalThis as Record<string, unknown>).__camOverride as { pos: number[] } | undefined; if (o) _c.fromArray(o.pos) } // dev screenshots
      const face = _c.sub(_p).normalize().dot(_n.normalize())
      _c.setFromMatrixPosition(camera.matrixWorld)
      if (import.meta.env.DEV) { const o = (globalThis as Record<string, unknown>).__camOverride as { pos: number[] } | undefined; if (o) _c.fromArray(o.pos) }
      root.current?.parent?.worldToLocal(_c)
      const side = accept(_c) ? 1 : 0
      const k = side * Math.min(1, Math.max(0, (face - 0.2) / 0.4))
      setHalo(halo, _p, null, 0.1, 0.12 * k, 0.8, 0.85, 0.95)
    }
  })

  return (
    <group ref={root} position={position} rotation={[0, rotationY, 0]}>
      <mesh geometry={geo.paint} material={mats.paint} frustumCulled={false} />
      <mesh geometry={geo.steel} material={mats.steel} frustumCulled={false} />
      <mesh geometry={geo.hw} material={mats.hw} frustumCulled={false} />
      <mesh geometry={geo.dark} material={mats.rubber} frustumCulled={false} />
      <mesh ref={pipe} position={[0.022, 0, 0.0393]} material={pipeMat} frustumCulled={false}>
        <boxGeometry args={[0.0018, TRAVEL, 0.0008]} />
      </mesh>
      <group ref={capRef} position={[-0.008, 0, 0.04]}>
        <mesh geometry={geo.stem} material={mats.hw} frustumCulled={false} />
        <mesh geometry={geo.cap} material={mats.rubber} frustumCulled={false} />
        <mesh position={[0, 0, 0.0225]} material={line} frustumCulled={false}>
          <boxGeometry args={[0.03, 0.0024, 0.0012]} />
        </mesh>
      </group>
      {/* hit strips across the plate (invisible material, still raycastable) */}
      {Array.from({ length: STEPS }, (_, k) => {
        const end = k === 0 || k === STEPS - 1
        const h = HIT_H + (end ? 0.03 : 0)
        const yc = -TRAVEL / 2 + k * HIT_H + (k === 0 ? -0.015 : k === STEPS - 1 ? 0.015 : 0)
        return (
          <Interactable key={k} id={`${id}-${k}`} onInteract={() => onStep(k)}>
            <mesh position={[0, yc, 0.05]} material={hitMat}>
              <boxGeometry args={[PW + 0.01, h, 0.03]} />
            </mesh>
          </Interactable>
        )
      })}
    </group>
  )
}
