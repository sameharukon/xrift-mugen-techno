import { Interactable, useInstanceState, useServerClock } from '@xrift/world-components'
import { RigidBody } from '@react-three/rapier'
import { useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useRef } from 'react'
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three'
import { BANDS } from '../../techno/engine'
import { useConcrete } from '../Club'
import { beat } from '../../techno/beat'
import { buildClubPA, type ClubPA } from '../../techno/clubPA'
import { FIXED_BAND, IDLE_SESSION, SyncedTechno, newSession, type DJEvent, type DJSession } from '../../techno/sync'

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
  sync: SyncedTechno
}

const STATE_ID = 'techno-dj-session-v1'
/** max events kept in the shared log (late joiners replay the whole log) */
const LOG_MAX = 400
/** a session older than this is treated as stale (e.g. instance state left over after everyone left) */
const STALE_MS = 3 * 3600 * 1000

const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpC = new Vector3()

function setParam(p: AudioParam | undefined, v: number, t: number) {
  if (p) p.setTargetAtTime(v, t, 0.03)
}

/** seconds for the world lighting to fade in / out on start / stop */
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
  const [rawSession, setSession] = useInstanceState<DJSession>(STATE_ID, IDLE_SESSION)
  const clock = useServerClock({ require: 'media' })
  const session = rawSession.playing && clock.now() - rawSession.t0 > STALE_MS ? { ...rawSession, playing: false } : rawSession
  const clockRef = useRef(clock)
  clockRef.current = clock
  const sessionRef = useRef(session)
  sessionRef.current = session
  const setSessionRef = useRef(setSession)
  setSessionRef.current = setSession

  const rig = useRef<AudioRig | null>(null)
  const wantListen = useRef(false)
  const panelMat = useRef<MeshStandardMaterial>(null)
  const playMat = useRef<MeshStandardMaterial>(null)
  const ringRef = useRef<Mesh>(null)
  const platters = useRef<(Mesh | null)[]>([])
  const concrete = useConcrete(1)
  const glowMats = useRef<{ m: MeshStandardMaterial; k: number }[]>([])
  const addGlow = useCallback((k: number) => (m: MeshStandardMaterial | null) => {
    if (m && !glowMats.current.some((g) => g.m === m)) glowMats.current.push({ m, k })
  }, [])
  const lastKickStep = useRef(-1)

  // AudioContext is created / resumed only from a user interaction (autoplay policy)
  const ensureAudio = useCallback(async (): Promise<AudioRig> => {
    if (!rig.current) {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      // club PA: mono low bed + stereo mid/high bed + spatial stacks + basement reverb (see clubPA.ts)
      const pa = buildClubPA(ctx, paRef.current.map((s) => ({ side: s.side })))
      const input = pa.input
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.6
      // visuals were tuned with 0.6 into the analyser → keep that reference regardless of the PA master level
      const anaTrim = ctx.createGain()
      anaTrim.gain.value = 0.6 / input.gain.value
      input.connect(anaTrim).connect(analyser)
      const sync = new SyncedTechno(ctx, input, () => clockRef.current.now())
      sync.onEnded = (sid) => setSessionRef.current((prev) => (prev.sid === sid && prev.playing ? { ...prev, playing: false } : prev))
      rig.current = { ctx, input, pa, analyser, freq: new Uint8Array(analyser.frequencyBinCount), sync }
      if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__techno = rig.current
    }
    if (rig.current.ctx.state !== 'running') await rig.current.ctx.resume()
    return rig.current
  }, [])

  // shared state → local engine
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const r = rig.current
    if (!r) return
    if (session.playing && wantListen.current && (!r.sync.joined || r.sync.sid !== session.sid)) r.sync.join(session)
    else r.sync.update(session)
  }, [rawSession, session.playing])

  // server clock jumped → re-measure the audio/server offset
  useEffect(() => {
    rig.current?.sync.clockJumped()
  }, [clock.timeJumpCount])

  const appendEvent = useCallback((ev: DJEvent) => {
    const sid = rig.current?.sync.sid
    setSessionRef.current((prev) => (prev.playing && prev.sid === sid ? { ...prev, log: [...prev.log, ev].slice(-LOG_MAX) } : prev))
  }, [])

  const onPlay = useCallback(async () => {
    const r = await ensureAudio()
    wantListen.current = true
    const s = sessionRef.current
    if (!s.playing) {
      setSession(newSession(clockRef.current.now()))
      return
    }
    if (!r.sync.joined || r.sync.sid !== s.sid) {
      // music already running in the instance: join in sync (no restart)
      r.sync.join(s)
      return
    }
    if (r.sync.isClosing) {
      // second stop while closing → immediate stop for everyone
      setSession((prev) => (prev.sid === s.sid ? { ...prev, playing: false } : prev))
    } else {
      appendEvent(r.sync.makeEvent('stop'))
    }
  }, [ensureAudio, setSession, appendEvent])

  // dev-only test hooks (stripped from production builds)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const g = globalThis as Record<string, unknown>
    g.__technoPlay = onPlay
    g.__technoSession = () => sessionRef.current
    g.__beat = beat
    return () => { delete g.__technoPlay; delete g.__technoSession; delete g.__beat }
  }, [onPlay])

  useEffect(() => {
    return () => {
      const r = rig.current
      rig.current = null
      if (!r) return
      r.sync.dispose()
      setTimeout(() => void r.ctx.close().catch(() => undefined), 700)
    }
  }, [])

  useFrame(({ camera }, delta) => {
    const r = rig.current
    const s = sessionRef.current
    const joined = !!r && r.sync.joined
    const st = r ? r.sync.getState() : null

    // ---- spatial audio: panner at the booth, listener at the camera ----
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
    if (joined && r && st) {
      const heard = r.sync.audibleTime()
      const ev = r.sync.events
      let brk = beat.breakAmt > 0.5, riser = 0, energy = beat.energy, tension = beat.tension
      while (ev.length && ev[0].t <= heard) {
        const e = ev.shift()!
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
      beat.active = st.status === 'live'
      beat.audible = beat.active
      beat.bpm = st.bpm
      beat.time = clockRef.current.now() / 1000 - s.t0 / 1000
      r.analyser.getByteFrequencyData(r.freq)
      const n = r.freq.length
      for (let b = 0; b < 16; b++) {
        const lo = Math.floor(Math.pow(n, b / 16)), hi = Math.max(lo + 1, Math.floor(Math.pow(n, (b + 1) / 16)))
        let m = 0
        for (let i = lo; i < hi && i < n; i++) m = Math.max(m, r.freq[i])
        beat.levels[b] = Math.max(0, (m - 60) / 170)
      }
    } else if (s.playing) {
      // not listening locally: approximate grid from the server clock (start tempo of the band)
      const bpm = (BANDS[s.band] || BANDS[FIXED_BAND]).start
      const tt = clockRef.current.now() / 1000 - s.t0 / 1000
      const step = Math.floor(tt / (60 / bpm / 4))
      beat.active = tt >= 0
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

    // ---- master light level: everything except the play button is black unless the music is on ----
    beat.litRaw = Math.min(1, Math.max(0, beat.litRaw + (beat.active ? 1 : -1) * (delta / FADE_S)))
    beat.lit = beat.litRaw * beat.litRaw * (3 - 2 * beat.litRaw)
    const L = beat.lit

    // ---- booth: play button shows the join state without text ----
    const tnow = performance.now() / 1000
    const live = joined && st?.status === 'live'
    const syncing = joined && st?.status === 'syncing'
    if (playMat.current) {
      playMat.current.emissiveIntensity = live
        ? 1.4 + 0.8 * beat.kickHit // solid + kick
        : syncing
          ? 0.6 + 0.6 * (Math.sin(tnow * 12) > 0 ? 1 : 0) // quick blink while syncing
          : s.playing
            ? 0.25 + 1.3 * (0.5 - 0.5 * Math.cos(tnow * Math.PI)) // slow breathing (0.5 Hz): music is on, click to join
            : 0.45 // faint glow: stopped (the only visible thing in the dark room)
      playMat.current.emissive.set(live && st?.closing ? '#c4101c' : '#e8eeff') // cold white; deep red while closing
    }
    if (ringRef.current) {
      const k = live ? 1 + 0.3 * beat.kickHit : s.playing && !joined ? 1 + 0.25 * (0.5 - 0.5 * Math.cos(tnow * Math.PI)) : 1
      ringRef.current.scale.set(k, k, 1)
      ;(ringRef.current.material as MeshBasicMaterial).opacity = s.playing ? 0.95 : 0.35
    }
    if (panelMat.current) panelMat.current.emissiveIntensity = L * (1 - beat.preDrop) * (0.05 + 4 * beat.kickHit + 2 * beat.dropFlash)
    for (const m of edgeMats.current) m.color.setRGB(0.87, 0.91, 1).multiplyScalar(L * (1 - beat.preDrop) * (0.08 + 0.12 * beat.redHit + 0.7 * beat.whiteEnv))
    for (const m of ledMats.current) if (m) m.color.setRGB(0.77, 0.06, 0.11).multiplyScalar(L * (1 - beat.preDrop) * beat.kickHit * beat.kickHit)
    for (const g of glowMats.current) g.m.emissiveIntensity = L * (1 - beat.preDrop) * g.k * (0.2 + 1.6 * beat.kickHit)
    for (const p of platters.current) if (p && beat.active) p.rotation.y -= delta * (beat.bpm / 60) * 1.4
  })

  return (
    <group position={position} rotation={rotation}>
      {/* table */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
          <boxGeometry args={[3.6, 1, 1.2]} />
          <meshStandardMaterial map={concrete} color="#6a6a6a" roughness={0.95} metalness={0} />
        </mesh>
      </RigidBody>
      {/* raw steel angle trim (unlit; only catches the show lights) */}
      {[0.61, -0.61].map((z) => (
        <mesh key={z} position={[0, 1.0, z]}>
          <boxGeometry args={[3.66, 0.05, 0.05]} />
          <meshStandardMaterial color="#2a2b2e" metalness={0.9} roughness={0.45} />
        </mesh>
      ))}
      {/* thin deep-red line (kick ambience) */}
      <mesh position={[0, 0.5, 0.605]}>
        <planeGeometry args={[3.5, 0.03]} />
        <meshStandardMaterial ref={panelMat} color="#0b0b0b" emissive="#c4101c" emissiveIntensity={0} />
      </mesh>
      {/* decks + mixer (decor) on the back half of the table */}
      {[-1.15, 1.15].map((x, i) => (
        <group key={x} position={[x, 1.0, -0.3]}>
          <mesh position={[0, 0.03, 0]}>
            <boxGeometry args={[0.9, 0.06, 0.5]} />
            <meshStandardMaterial color="#1b1b1c" metalness={0.7} roughness={0.5} />
          </mesh>
          <mesh ref={(m) => { platters.current[i] = m }} position={[-0.1, 0.075, 0]}>
            <cylinderGeometry args={[0.2, 0.2, 0.03, 32]} />
            <meshStandardMaterial color="#0d0d0f" roughness={0.3} />
          </mesh>
          <mesh position={[-0.1, 0.095, 0.12]}>
            <boxGeometry args={[0.03, 0.01, 0.06]} />
            <meshStandardMaterial color="#8a8a8a" />
          </mesh>
        </group>
      ))}
      <group position={[0, 1.0, -0.3]}>
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[0.55, 0.08, 0.5]} />
          <meshStandardMaterial color="#1e1e1f" metalness={0.7} roughness={0.5} />
        </mesh>
        {[-0.15, 0, 0.15].map((x) => [-0.12, 0.02].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 0.1, z]}>
            <cylinderGeometry args={[0.025, 0.025, 0.04, 12]} />
            <meshStandardMaterial ref={addGlow(0.5)} color="#555" emissive="#c4101c" emissiveIntensity={0} />
          </mesh>
        )))}
      </group>
      {/* booth monitors: small wedges on the table ends (unlit) */}
      {[-1.65, 1.65].map((x) => (
        <mesh key={x} position={[x, 1.14, -0.35]} rotation={[0.35, x > 0 ? -0.5 : 0.5, 0]}>
          <boxGeometry args={[0.32, 0.28, 0.3]} />
          <meshStandardMaterial color="#111" roughness={0.8} />
        </mesh>
      ))}
      {/* PA stacks (sub + top); their positions drive the spatial PA panners */}
      {pa.map((sp, i) => (
        <group key={i} position={sp.position} rotation={[0, sp.yaw, 0]} ref={(g) => { stackRefs.current[i] = g }}>
          <SpeakerStack ledRef={(m) => { ledMats.current[i] = m }} edgeRef={(m) => { if (m && !edgeMats.current.includes(m)) edgeMats.current.push(m) }} />
        </group>
      ))}

      {/* play / stop / join */}
      <Interactable id="dj-play" onInteract={() => void onPlay()}>
        <group position={[0, 1.0, 0.25]}>
          <mesh position={[0, 0.06, 0]}>
            <cylinderGeometry args={[0.3, 0.3, 0.12, 40]} />
            <meshStandardMaterial ref={playMat} color="#202020" emissive="#e8eeff" emissiveIntensity={0.4} />
          </mesh>
          <mesh ref={ringRef} position={[0, 0.125, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.19, 0.26, 40]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.35} toneMapped={false} />
          </mesh>
        </group>
      </Interactable>

    </group>
  )
}
