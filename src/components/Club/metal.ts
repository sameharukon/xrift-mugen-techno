/**
 * v16 shared metal materials. All brushed metals share one texture set (brushedColor / RM / Normal) and all painted
 * steel shares the door set, so every variant compiles to the same few programs (pre-warmed with the rest).
 * Geometry must use metre-based UVs (geo.ts Builder(tile) / metalUV) so texel density matches everywhere.
 */
import { MeshStandardMaterial } from 'three'
import { brushedColor, brushedNormal, brushedRM, steelColor, steelNormal, steelRM } from './textures'

/** brushed steel / aluminium: directional grain, smudges + fingerprints, fine scratches, restrained grooves */
export function brushedMetal(color: string, metalness = 0.92, normal = 0.3) {
  const m = new MeshStandardMaterial({ color, metalness, roughness: 1, map: brushedColor(), roughnessMap: brushedRM(), normalMap: brushedNormal() })
  m.normalScale.set(normal, normal)
  return m
}
/** painted steel: dielectric paint (metalness from the map), bare-steel scuffs, rust, grime towards the floor */
export function paintedSteel(color: string, normal = 0.5) {
  const m = new MeshStandardMaterial({ color, map: steelColor(), roughnessMap: steelRM(), metalnessMap: steelRM(), normalMap: steelNormal(), roughness: 1, metalness: 1 })
  m.normalScale.set(normal, normal)
  return m
}
