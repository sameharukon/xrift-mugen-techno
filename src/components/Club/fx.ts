/**
 * v12 shared light-FX state (local, per frame; no sync needed):
 *  - brightest tube / strobe levels (written by the TubeWall / LightRig, read by the env map and the haze sheets)
 *  - fake-bloom halo slots (written by the light sources, drawn by one instanced HaloField)
 *  - dark environment map registry (materials opt in; intensity follows the lighting)
 * All positions are WORLD space.
 */
import type { MeshStandardMaterial, Texture, Vector3 } from 'three'

export const fx = {
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
  /** v16: warm corridor env (one caged tungsten bulb above the door) for the `always` (entrance) materials */
  texCorr: null as Texture | null,
  /** v16: the club map the right way up + richer horizon / floor-pool content: used by the metals only (`metal`), so
   *  non-metal opt-ins (wet floor, case laminate, plastics, screens) keep exactly their v15 look */
  texMetal: null as Texture | null,
  mats: [] as { m: MeshStandardMaterial; base: number; always?: boolean; metal?: boolean }[],
}
/** opt a material into the club env map; `base` = envMapIntensity at full light (`always`: constant, e.g. the entrance outside the club) */
export function envOn(m: MeshStandardMaterial | null, base: number, always = false, metal = false) {
  if (!m || envReg.mats.some((x) => x.m === m)) return
  envReg.mats.push({ m, base, always, metal })
  const t = envFor(always, metal)
  if (t) { m.envMap = t; m.envMapIntensity = always ? base : 0; m.needsUpdate = true }
}

export const envFor = (always?: boolean, metal?: boolean) => (always ? envReg.texCorr : metal ? envReg.texMetal : envReg.tex)

/** colour temperatures for "fluorescent" sources (cool / neutral / warm-ish), deterministic per index */
export const TINTS: [number, number, number][] = [[0.87, 0.91, 1.0], [0.95, 0.96, 1.0], [1.0, 0.95, 0.88], [0.9, 0.94, 1.0], [1.0, 0.97, 0.92]]

// ---------------------------------------------------------------- shader clock (float32-safe)
/**
 * Seconds for time-animated shaders, wrapped to a short period. Raw `performance.now() / 1000` keeps growing for as
 * long as the page is open; on the GPU (float32, and mobile sin / fract / texture-coordinate precision) large time
 * values make noise scrolls, mist wavering and twinkles step and jitter more and more the longer a session runs.
 *  - texture-noise scrolls: every speed used × PERIOD is a whole number of (tiling) texture repeats → the wrap is seamless
 *  - procedural noise (crowd mist): crossfade over FADE s into the field evaluated at (t − PERIOD), which is exactly
 *    where the next period starts → continuous
 *  - corridor dust: dims out / back in around the wrap (`vis`)
 */
export const SHADER_PERIOD = 1000
const FADE = 8
export function shaderClock(nowMs = performance.now()) {
  const t = (nowMs / 1000) % SHADER_PERIOD
  const s = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v) }
  return { t, fade: s((t - (SHADER_PERIOD - FADE)) / FADE), vis: s(t / (FADE / 2)) * (1 - s((t - (SHADER_PERIOD - FADE / 2)) / (FADE / 2))) }
}
