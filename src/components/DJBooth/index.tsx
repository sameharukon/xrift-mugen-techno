import { useServerClock } from '@xrift/world-components'
import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useRef } from 'react'
import { Group, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three'
import { BANDS } from '../../techno/engine'
import { BoothGear } from './Gear'
import { beat } from '../../techno/beat'
import { buildClubPA, type ClubPA } from '../../techno/clubPA'
import { volume, volumeGain } from '../../techno/volume'
import { FIXED_BAND, PerpetualTechno, segIndexAt, segStartMs } from '../../techno/sync'
import { club } from '../../techno/club'

export interface PAStack {
  /** stack position relative to the booth (floor level) */
  position: [number, number, number]
  /** yaw (rad), cabinets face local +z */
  yaw: number
  side: 'L' | 'R'
}

export interface DJBoothProps {
  position?: [number, number, number]
  rotation?: [number, number, number]
  /** PA speaker stacks (audio sources + props). Default: a single pair beside the booth */
  pa?: PAStack[]
}

const DEFAULT_PA: PAStack[] = [
  { position: [-2.4, 0, -0.4], yaw: 0, side: 'L' },
  { position: [2.4, 0, -0.4], yaw: 0, side: 'R' },
]
/** height of the acoustic centre of a stack (between sub and top) */
const PA_Y = 1.35

interface AudioRig {
  ctx: AudioContext
  input: GainNode
  pa: ClubPA
  analyser: AnalyserNode
  freq: Uint8Array<ArrayBuffer>
  sync: PerpetualTechno
  muffle: BiquadFilterNode
  muffleGain: GainNode
  /** per-user volume (after the limiter and the door muffle → applies inside and outside) */
  vol: GainNode
  volLevel: number
}

/** closed door: low-pass corner (Hz) and level of the PA as heard from the corridor */
const MUFFLE_HZ = 160
const MUFFLE_GAIN = 0.45
/** fully inside: effectively no filter */
const OPEN_HZ = 20000
/** inside but the AudioContext never started: fall back to a clock-driven light grid after this (ms) */
const NO_AUDIO_FALLBACK_MS = 2500

const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpC = new Vector3()

function setParam(p: AudioParam | undefined, v: number, t: number) {
  if (p) p.setTargetAtTime(v, t, 0.03)
}

/** seconds for the club lighting to fade in when this user enters */
const FADE_S = 1.0


/** dark industrial PA stack: double-18 sub + 2-way top, metal grilles, tiny red kick LED (dark when stopped) */
function SpeakerStack({ ledRef, edgeRef }: { ledRef: (m: MeshBasicMaterial | null) => void; edgeRef: (m: MeshBasicMaterial | null) => void }) {
  return (
    <group>
      {/* sub */}
      <mesh position={[0, 0.42, 0]}>
        <boxGeometry args={[0.78, 0.84, 0.7]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.75} metalness={0.2} />
      </mesh>
      {[0.2, -0.2].map((x) => (
        <mesh key={x} position={[x, 0.42, 0.352]}>
          <circleGeometry args={[0.17, 16]} />
          <meshStandardMaterial color="#070707" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}
      {/* top cabinet, slightly tilted down to the crowd */}
      <group position={[0, 1.2, 0.02]} rotation={[0.08, 0, 0]}>
        <mesh>
          <boxGeometry args={[0.6, 0.72, 0.5]} />
          <meshStandardMaterial color="#2c2c2c" roughness={0.7} metalness={0.2} />
        </mesh>
        <mesh position={[0, -0.1, 0.252]}>
          <circleGeometry args={[0.2, 16]} />
          <meshStandardMaterial color="#080808" roughness={0.6} metalness={0.3} />
        </mesh>
        <mesh position={[0, 0.22, 0.252]}>
          <planeGeometry args={[0.36, 0.1]} />
          <meshStandardMaterial color="#0a0a0a" roughness={0.5} metalness={0.4} />
        </mesh>
        {/* steel corners: fake glints that catch the white hits (rate-limited envelope) */}
        {[-0.3, 0.3].map((x) => (
          <mesh key={x} position={[x, 0, 0.25]}>
            <boxGeometry args={[0.03, 0.72, 0.03]} />
            <meshBasicMaterial ref={edgeRef} color="#000000" toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0.24, -0.31, 0.253]}>
          <circleGeometry args={[0.022, 8]} />
          <meshBasicMaterial ref={ledRef} color="#000000" toneMapped={false} />
        </mesh>
      </group>
    </group>
  )
}

export const DJBooth: React.FC<DJBoothProps> = ({ position = [0, 0, 0], rotation = [0, 0, 0], pa = DEFAULT_PA }) => {
  const paRef = useRef(pa)
  paRef.current = pa
  const stackRefs = useRef<(Group | null)[]>([])
  const ledMats = useRef<(MeshBasicMaterial | null)[]>([])
  const edgeMats = useRef<MeshBasicMaterial[]>([])
  const clock = useServerClock({ require: 'media' })
  const clockRef = useRef(clock)
  clockRef.current = clock
  const gl = useThree((s) => s.gl)

  const rig = useRef<AudioRig | null>(null)
  const panelMat = useRef<MeshStandardMaterial>(null)
  const lastKickStep = useRef(-1)
  const enteredAt = useRef(0)

  // AudioContext: created lazily and resumed from the first user gesture (autoplay policy);
  // the perpetual timeline starts as soon as it runs (muffled while the listener is outside)
  const unlock = useCallback(() => {
    if (!rig.current) {
      let ctx: AudioContext
      try { ctx = new AudioContext({ latencyHint: 'interactive' }) } catch { return }
      // muffle stage (closed door): low-pass + level on the whole PA output
      const muffle = ctx.createBiquadFilter()
      muffle.type = 'lowpass'
      muffle.frequency.value = MUFFLE_HZ
      muffle.Q.value = 0.5
      const muffleGain = ctx.createGain()
      muffleGain.gain.value = MUFFLE_GAIN
      const vol = ctx.createGain()
      vol.gain.value = volumeGain(volume.level)
      muffle.connect(muffleGain).connect(vol).connect(ctx.destination)
      // club PA: mono low bed + stereo mid/high bed + spatial stacks + basement reverb (see clubPA.ts)
      const pa = buildClubPA(ctx, paRef.current.map((s) => ({ side: s.side })), {}, muffle)
      const input = pa.input
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.6
      // visuals were tuned with 0.6 into the analyser → keep that reference regardless of the PA master level
      const anaTrim = ctx.createGain()
      anaTrim.gain.value = 0.6 / input.gain.value
      input.connect(anaTrim).connect(analyser)
      const sync = new PerpetualTechno(ctx, input, () => clockRef.current.now() + (import.meta.env.DEV ? Number((globalThis as Record<string, unknown>).__clockSkewMs) || 0 : 0))
      rig.current = { ctx, input, pa, analyser, freq: new Uint8Array(analyser.frequencyBinCount), sync, muffle, muffleGain, vol, volLevel: volume.level }
      if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__techno = rig.current
      volume.onChange = (l) => { const R = rig.current; if (R) { R.volLevel = l; R.vol.gain.setTargetAtTime(volumeGain(l), R.ctx.currentTime, 0.04) } }
    }
    const r = rig.current
    const go = () => {
      club.audio = r.ctx.state === 'running'
      if (club.audio && !r.sync.running) r.sync.start()
    }
    if (r.ctx.state !== 'running') r.ctx.resume().then(go, () => undefined)
    else go()
  }, [])

  // first gesture anywhere (incl. the pointer-lock click) / XR session start → unlock audio
  useEffect(() => {
    club.unlock = unlock
    const opts = { capture: true, passive: true } as const
    const evs = ['pointerdown', 'keydown', 'touchstart', 'mousedown', 'click'] as const
    for (const e of evs) window.addEventListener(e, unlock, opts)
    document.addEventListener('pointerlockchange', unlock)
    const xr = gl.xr as unknown as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }
    xr.addEventListener?.('sessionstart', unlock)
    return () => {
      for (const e of evs) window.removeEventListener(e, unlock, opts)
      document.removeEventListener('pointerlockchange', unlock)
      xr.removeEventListener?.('sessionstart', unlock)
      club.unlock = () => undefined
    }
  }, [unlock, gl])

  // server clock jumped → re-measure the audio/server offset
  useEffect(() => {
    rig.current?.sync.clockJumped()
  }, [clock.timeJumpCount])

  // dev-only test hooks (stripped from production builds)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const g = globalThis as Record<string, unknown>
    g.__beat = beat
    g.__club = club
    g.__unlock = unlock
    return () => { delete g.__beat; delete g.__club; delete g.__unlock }
  }, [unlock])

  useEffect(() => {
    return () => {
      const r = rig.current
      rig.current = null
      club.audio = false
      if (!r) return
      r.sync.dispose()
      setTimeout(() => void r.ctx.close().catch(() => undefined), 700)
    }
  }, [])

  useFrame(({ camera }, delta) => {
    const r = rig.current
    const st = r && r.sync.running ? r.sync.getState() : null
    const live = !!st && st.status === 'live'
    club.syncing = !!st && st.status === 'syncing'

    // ---- spatial audio: panners at the stacks, listener at the camera; muffled through the door ----
    if (r) {
      const t = r.ctx.currentTime
      const L = r.ctx.listener
      camera.getWorldPosition(tmpA)
      camera.getWorldDirection(tmpB)
      tmpC.set(0, 1, 0).applyQuaternion(camera.quaternion)
      if (L.positionX) {
        setParam(L.positionX, tmpA.x, t); setParam(L.positionY, tmpA.y, t); setParam(L.positionZ, tmpA.z, t)
        setParam(L.forwardX, tmpB.x, t); setParam(L.forwardY, tmpB.y, t); setParam(L.forwardZ, tmpB.z, t)
        setParam(L.upX, tmpC.x, t); setParam(L.upY, tmpC.y, t); setParam(L.upZ, tmpC.z, t)
      } else {
        L.setPosition(tmpA.x, tmpA.y, tmpA.z)
        L.setOrientation(tmpB.x, tmpB.y, tmpB.z, tmpC.x, tmpC.y, tmpC.z)
      }
      r.pa.panners.forEach((P, i) => {
        const g = stackRefs.current[i]
        if (!g) return
        tmpA.set(0, PA_Y, 0)
        g.localToWorld(tmpA)
        if (P.positionX) { setParam(P.positionX, tmpA.x, t); setParam(P.positionY, tmpA.y, t); setParam(P.positionZ, tmpA.z, t) }
        else P.setPosition(tmpA.x, tmpA.y, tmpA.z)
      })
      // closed door: heavy low-pass (only the kick / bass gets through); open door: opens up as you walk in
      const m = club.outside * (1 - 0.75 * club.door)
      r.muffle.frequency.setTargetAtTime(MUFFLE_HZ * Math.pow(OPEN_HZ / MUFFLE_HZ, 1 - m), t, 0.08)
      r.muffleGain.gain.setTargetAtTime(MUFFLE_GAIN + (1 - MUFFLE_GAIN) * (1 - m), t, 0.08)
      // volume fader: short exponential approach (≈ 40 ms) → no zipper noise / clicks
      if (r.volLevel !== volume.level) { r.volLevel = volume.level; r.vol.gain.setTargetAtTime(volumeGain(volume.level), t, 0.04) }
    }

    // ---- musical events → visual state (released on the audio clock, when they are heard) ----
    const dk = (rate: number) => Math.exp(-delta * rate)
    beat.kick *= dk(7)
    beat.hat *= dk(18)
    beat.clap *= dk(9)
    beat.perc *= dk(14)
    beat.stab *= dk(5)
    beat.bass *= dk(2.5)
    beat.dropFlash *= dk(5)
    beat.kickHit *= dk(12)
    const nowMs = performance.now()
    const kickNBefore = beat.kickN
    if (club.entered && !enteredAt.current) enteredAt.current = nowMs
    const srvNow = clockRef.current.now()
    if (live && r && st) {
      const heard = r.sync.audibleTime()
      const ev = r.sync.events
      let brk = beat.breakAmt > 0.5, riser = 0, energy = beat.energy, tension = beat.tension
      while (ev.length && ev[0].t <= heard) {
        const e = ev.shift()!
        if (!club.entered) continue // outside: the music runs (muffled), the club stays dark
        beat.step = e.step
        beat.bar = e.bar
        if (e.kick > 0) { beat.kick = Math.min(1, 0.6 + 0.4 * e.kick); beat.kickN++ }
        if (e.hat > 0) beat.hat = Math.min(1, e.hat)
        if (e.clap > 0) { beat.clap = 1; beat.clapN++ }
        if (e.perc > 0) beat.perc = Math.min(1, e.perc)
        if (e.bass > 0) beat.bass = Math.max(beat.bass, 0.8)
        if (e.stab > 0) { beat.stab = Math.min(1, e.stab); beat.stabSwing += 0.12 * Math.min(1, e.stab) }
        if (e.drop) beat.dropFlash = 1
        brk = e.brk
        riser = e.riser ? Math.max(0.05, e.brkProg) : 0
        energy = e.energy
        tension = e.tension
        beat.chill = e.chill
      }
      beat.riser = riser || (brk ? beat.riser : 0)
      // drop already scheduled (in the lookahead queue) but not heard yet → blackout until it lands
      beat.preDrop = ev.some((e) => e.drop) ? 1 : 0
      beat.breakAmt += ((brk ? 1 : 0) - beat.breakAmt) * Math.min(1, delta * 3)
      beat.energy += (energy - beat.energy) * Math.min(1, delta * 2)
      beat.tension = tension
      beat.active = club.entered
      beat.audible = beat.active
      beat.bpm = st.bpm
      beat.time = (srvNow - segStartMs(st.seg)) / 1000
      r.analyser.getByteFrequencyData(r.freq)
      const n = r.freq.length
      for (let b = 0; b < 16; b++) {
        const lo = Math.floor(Math.pow(n, b / 16)), hi = Math.max(lo + 1, Math.floor(Math.pow(n, (b + 1) / 16)))
        let mx = 0
        for (let i = lo; i < hi && i < n; i++) mx = Math.max(mx, r.freq[i])
        beat.levels[b] = Math.max(0, (mx - 60) / 170)
      }
    } else if (club.entered && nowMs - enteredAt.current > NO_AUDIO_FALLBACK_MS) {
      // inside but no audio (AudioContext blocked / failed): approximate grid from the server clock
      const bpm = (BANDS[FIXED_BAND] as { start: number }).start
      const tt = (srvNow - segStartMs(segIndexAt(srvNow))) / 1000
      const step = Math.floor(tt / (60 / bpm / 4))
      beat.active = true
      beat.audible = false
      beat.bpm = bpm
      beat.time = tt
      beat.breakAmt *= dk(3)
      beat.riser = 0; beat.preDrop = 0
      beat.energy += (0.5 - beat.energy) * Math.min(1, delta)
      if (step !== beat.step && step >= 0) {
        beat.step = step
        beat.bar = Math.floor(step / 16)
        if (step % 4 === 0 && step !== lastKickStep.current) { beat.kick = 1; beat.kickN++; lastKickStep.current = step }
        if (step % 4 === 2) beat.hat = 0.7
        if (step % 8 === 4) { beat.clap = 0.6; beat.clapN++ }
      }
      for (let b = 0; b < 16; b++) beat.levels[b] = (0.25 + 0.5 * beat.kick * (1 - b / 20)) * (0.6 + 0.4 * Math.sin(b * 1.3 + tt * 3))
    } else {
      beat.active = false
      beat.audible = false
      beat.breakAmt *= dk(3)
      beat.riser = 0; beat.preDrop = 0
    }

    if (beat.kickN !== kickNBefore && nowMs - beat.kickHitAt >= 250) { beat.kickHit = 1; beat.kickHitAt = nowMs }

    // ---- master light level: the club is black until this user is inside and the music runs ----
    beat.litRaw = Math.min(1, Math.max(0, beat.litRaw + (beat.active ? 1 : -1) * (delta / FADE_S)))
    beat.lit = beat.litRaw * beat.litRaw * (3 - 2 * beat.litRaw)
    const Lt = beat.lit

    if (panelMat.current) panelMat.current.emissiveIntensity = Lt * (1 - beat.preDrop) * (0.05 + 4 * beat.kickHit + 2 * beat.dropFlash)
    for (const m of edgeMats.current) m.color.setRGB(0.87, 0.91, 1).multiplyScalar(Lt * (1 - beat.preDrop) * (0.08 + 0.12 * beat.redHit + 0.7 * beat.whiteEnv))
    for (const m of ledMats.current) if (m) m.color.setRGB(0.77, 0.06, 0.11).multiplyScalar(Lt * (1 - beat.preDrop) * beat.kickHit * beat.kickHit)
  })

  return (
    <group position={position} rotation={rotation}>
      {/* flight-case table + CDJs / mixer / laptop / headphones / monitors / cables */}
      <BoothGear panelRef={panelMat} />
      {/* PA stacks (sub + top); their positions drive the spatial PA panners */}
      {pa.map((sp, i) => (
        <group key={i} position={sp.position} rotation={[0, sp.yaw, 0]} ref={(g) => { stackRefs.current[i] = g }}>
          <SpeakerStack ledRef={(m) => { ledMats.current[i] = m }} edgeRef={(m) => { if (m && !edgeMats.current.includes(m)) edgeMats.current.push(m) }} />
        </group>
      ))}


    </group>
  )
}
