/**
 * Per-user master volume fader (local only, never synced). `level` is the fader position 0..1;
 * the centre (0.5) is 100 % = the tuned club level (default).
 *   lower half  0 → 100 %: cubic taper (≈ perceptual): 25 % travel → -18 dB, 40 % → -5.8 dB, 0 → mute
 *   upper half 100 → VOL_MAX: amplitude rises linearly with the % (200 % = ×2 = +6 dB), applied *before*
 *   the PA's glue limiter so loud peaks are caught there instead of clipping.
 * Not persisted: XRift's code security rules forbid storage access (no-storage-access).
 */
export const VOL_MAX = 2
export const volume = {
  /** 0..1 fader position (0.5 = 100 %) */
  level: 0.5,
  /** set by the audio rig: apply a new level right away (not only on the next frame) */
  onChange: null as null | ((level: number) => void),
}

/** fader position → percentage / 100 (0 .. VOL_MAX) */
export const volumeValue = (level: number) => {
  const p = Math.min(1, Math.max(0, level))
  return p <= 0.5 ? p * 2 : 1 + (VOL_MAX - 1) * (p * 2 - 1)
}
/** [post-limiter cut gain, pre-limiter boost gain] */
export const volumeStages = (level: number): [number, number] => {
  const v = volumeValue(level)
  return v <= 1 ? [v * v * v, 1] : [1, v]
}

export function setVolume(level: number) {
  volume.level = Math.min(1, Math.max(0, Math.round(level * 1000) / 1000))
  volume.onChange?.(volume.level)
}

if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__volume = volume
