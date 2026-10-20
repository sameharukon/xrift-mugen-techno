/**
 * Local (per-user) entrance state shared between the entrance door and the audio / light rig.
 * Nothing here is synced: the music itself is a function of the server clock (see sync.ts).
 */
export const club = {
  /** the door has been opened by this user: music + lights on (lights fade in over 1 s) */
  entered: false,
  /** door animation 0 (closed) .. 1 (open) */
  door: 0,
  /** AudioContext exists and is running */
  audio: false,
  /** 0 = listener inside the club .. 1 = outside in the corridor (set by the entrance every frame) */
  outside: 1,
  /** set by the audio rig: create / resume the AudioContext (call from a user gesture) */
  unlock: (): void => undefined,
}
