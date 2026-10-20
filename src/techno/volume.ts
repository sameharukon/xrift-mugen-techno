/**
 * Per-user master volume (local only, never synced). 0 = mute .. 1 = full (= the tuned club level).
 * Cubic taper ≈ perceptual: 0.5 → -18 dB, 0.8 → -5.8 dB, 0.1 → -60 dB.
 * Not persisted: XRift's code security rules forbid storage access (no-storage-access), and declaring the
 * exception would put a permission prompt in front of every visitor — so the level lives for the session.
 */
export const volume = {
  /** 0..1 fader position */
  level: 1,
  /** set by the audio rig: apply a new level right away (not only on the next frame) */
  onChange: null as null | ((level: number) => void),
}

export const volumeGain = (level: number) => {
  const l = Math.min(1, Math.max(0, level))
  return l * l * l
}

export function setVolume(level: number) {
  volume.level = Math.min(1, Math.max(0, Math.round(level * 1000) / 1000))
  volume.onChange?.(volume.level)
}

if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__volume = volume
