/**
 * v12 shared light-FX state (local, per frame; no sync needed):
 *  - beam world geometry (written by the LightRig, read by the haze sheets and the wet floor)
 *  - fake-bloom halo slots (written by the light sources, drawn by one instanced HaloField)
 *  - dark environment map registry (materials opt in; intensity follows the lighting)
 * All positions are WORLD space.
 */
import { Vector3, type MeshStandardMaterial, type Texture } from 'three'

export const MAX_BEAMS = 4
export const fx = {
  beams: Array.from({ length: MAX_BEAMS }, () => ({ p: new Vector3(0, -100, 0), d: new Vector3(0, -1, 0), len: 3.6, rad: 0.2, v: 0 })),
  /** brightest back-wall tube (0..1), for the haze near the wall */
  wallGlow: 0,
  /** brightest truss tube / strobe (0..1) */
  rigGlow: 0,
}

// ---------------------------------------------------------------- halos (fake bloom)
export const HALO_CAP = 48
export const halo = {
  n: 0,
  keys: new Map<string, number>(),
  /** center xyz + radius */
  c: new Float32Array(HALO_CAP * 4),
  /** half axis xyz (0 → round) + intensity */
  a: new Float32Array(HALO_CAP * 4),
  col: new Float32Array(HALO_CAP * 3),
}
/** stable slot per source key */
export function allocHalo(key: string): number {
  const k = halo.keys.get(key)
  if (k != null) return k
  const i = Math.min(HALO_CAP - 1, halo.n++)
  halo.keys.set(key, i)
  return i
}
export function setHalo(i: number, c: Vector3, axis: Vector3 | null, radius: number, intensity: number, r: number, g: number, b: number) {
  halo.c.set([c.x, c.y, c.z, radius], i * 4)
  if (axis) halo.a.set([axis.x, axis.y, axis.z, intensity], i * 4)
  else halo.a.set([0, 0, 0, intensity], i * 4)
  halo.col.set([r, g, b], i * 3)
}

// ---------------------------------------------------------------- environment map registry
export const envReg = {
  tex: null as Texture | null,
  mats: [] as { m: MeshStandardMaterial; base: number }[],
}
/** opt a material into the club env map; `base` = envMapIntensity at full light */
export function envOn(m: MeshStandardMaterial | null, base: number) {
  if (!m || envReg.mats.some((x) => x.m === m)) return
  envReg.mats.push({ m, base })
  if (envReg.tex) { m.envMap = envReg.tex; m.envMapIntensity = 0; m.needsUpdate = true }
}

/** colour temperatures for "fluorescent" sources (cool / neutral / warm-ish), deterministic per index */
export const TINTS: [number, number, number][] = [[0.87, 0.91, 1.0], [0.95, 0.96, 1.0], [1.0, 0.95, 0.88], [0.9, 0.94, 1.0], [1.0, 0.97, 0.92]]
