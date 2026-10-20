import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { PerspectiveCamera } from 'three'

/**
 * DEV ONLY (not mounted in production builds): screenshot camera override.
 * Set globalThis.__camOverride = { pos: [x, y, z], look: [x, y, z] } to render from that viewpoint;
 * delete it to return to the player camera. The player / physics / audio listener are untouched.
 */
const tmp = new PerspectiveCamera() // camera-style lookAt (looks down -z)
export function DevCamOverride() {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    ;(globalThis as Record<string, unknown>).__scene = scene // dev-only: thumbnail capture (hide helpers)
    const prev = scene.onBeforeRender
    scene.onBeforeRender = (renderer, sc, camera, ...rest) => {
      prev.call(scene, renderer, sc, camera, ...rest)
      ;(globalThis as Record<string, unknown>).__cam = camera
      const o = (globalThis as Record<string, unknown>).__camOverride as { pos: number[]; look: number[] } | undefined
      if (!o) return
      tmp.position.set(o.pos[0], o.pos[1], o.pos[2])
      tmp.lookAt(o.look[0], o.look[1], o.look[2])
      tmp.updateMatrixWorld(true)
      camera.matrixWorld.copy(tmp.matrixWorld)
      camera.matrixWorldInverse.copy(tmp.matrixWorld).invert()
    }
    return () => { scene.onBeforeRender = prev }
  }, [scene])
  return null
}
