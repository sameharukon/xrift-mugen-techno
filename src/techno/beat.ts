/**
 * Shared per-frame musical state for the club visuals.
 * Written once per frame by the DJ booth from the synced engine's per-step events, released on the
 * audio clock at the moment they reach the listener (scheduled time minus output latency).
 * The engine timeline is shared, so these values are the same for everyone in the instance.
 */
export const beat = {
  /** music is running (joined locally, or at least in the shared session) */
  active: false,
  /** master light level 0..1: ramps in/out over ~1 s on start/stop (smoothstepped). 0 → world is black */
  lit: 0,
  /** linear ramp behind `lit` */
  litRaw: 0,
  /** joined and hearing audio (levels come from the analyser) */
  audible: false,
  step: 0,
  bar: 0,
  bpm: 140,
  /** seconds since the session started (shared timeline) */
  time: 0,
  // ---- per-voice pulses (0..1, set to the event velocity, decay per frame) ----
  kick: 0,
  hat: 0,
  clap: 0,
  perc: 0,
  /** bass note level (held, slow decay) → low floor glow */
  bass: 0,
  /** short accent from a stab (nudges the truss's low tubes) */
  stab: 0,
  // ---- sections ----
  /** smoothed 0..1: 1 while a break / breakdown is running */
  breakAmt: 0,
  /** 0..1 progress of a running riser / build (0 when none) */
  riser: 0,
  /** 1 while a drop is already scheduled but not yet heard (≈0.25 s) → hard blackout before the slam */
  preDrop: 0,
  /** counters incremented on every heard kick / clap / bar (edge triggers for the visuals) */
  kickN: 0,
  /** snappy kick envelope, re-triggered at most every 250 ms (≤ 4 Hz even during kick rolls) */
  kickHit: 0,
  kickHitAt: -1e9,
  clapN: 0,
  /** current brightest white hit of the rig (strobes / tubes, 0..1) and red floor level, for the crowd mist */
  whiteHit: 0,
  /** rate-limited (≤ 4 Hz) white envelope derived from whiteHit (crowd mist, PA stack edges) */
  whiteEnv: 0,
  redHit: 0,
  /** big flash on the drop (break → full groove), decays fast */
  dropFlash: 0,
  /** conductor energy (smoothed) */
  energy: 0.5,
  tension: 0.3,
  chill: false,
  /** 0..1 spectrum bands (local analyser, or a synthetic pattern when not audible) */
  levels: new Float32Array(16),
}
