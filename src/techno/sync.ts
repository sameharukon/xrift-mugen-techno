/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Instance-synced live transport.
 *
 * Shared state (XRift useInstanceState) holds a DJSession: seed, start time on the server clock,
 * starting band and an ordered log of events, each tagged with the engine step it takes effect at.
 * The engine is deterministic given (seed, band, event log), so every client renders the same
 * music. Each client maps server time → its own AudioContext time (via the XRift server clock and
 * AudioContext.getOutputTimestamp), runs the engine on that timeline, and silently fast-forwards
 * (LazyAudio, nothing audible) over any part of the timeline it missed (late join, throttled tab).
 */
import { Engine, BANDS, PHASE_JA, phJa, resetS } from './engine'
import { LazyAudio } from './lazyAudio'

export type BandId = 'bchill' | 'b120' | 'b140'
export const BAND_ORDER: BandId[] = ['bchill', 'b120', 'b140']

export type DJEventKind = 'intent' | 'break' | 'band' | 'stop'
export interface DJEvent {
  id: string
  step: number
  kind: DJEventKind
  arg?: string | null
}
export interface DJSession {
  v: 1
  sid: string
  playing: boolean
  seed: number
  band: string
  /** server time (ms) of step 0 */
  t0: number
  log: DJEvent[]
}
/** every session runs in the 140 band (the auto-DJ never changes bands by itself) */
export const FIXED_BAND: BandId = 'b140'
export const IDLE_SESSION: DJSession = { v: 1, sid: '', playing: false, seed: 0, band: FIXED_BAND, t0: 0, log: [] }

export interface StepEvent {
  t: number
  bar: number
  step: number
  kick: number
  hat: number
  clap: number
  bass: number
  stab: number
  perc: number
  fill: number
  /** a break is active on this step */
  brk: boolean
  /** kick removed by the break */
  kickOut: boolean
  /** riser / build running */
  riser: boolean
  /** progress through the current break 0..1 */
  brkProg: number
  /** the break ended on this step (the drop) */
  drop: boolean
  energy: number
  tension: number
  chill: boolean
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'live'
  closing: boolean
  bpm: number
  band: string
  bandId: string
  style: string
  phase: string
  bar: number
  step: number
  message: string
  offsetMs: number
  resyncs: number
  ffSteps: number
}

const LOOKAHEAD = 0.25
const TICK_MS = 25
/** how far ahead (s) a button press is scheduled so every client receives it in time */
export const EVENT_LEAD = 1.2
const DRIFT_LIMIT = 0.03

const rid = () => Math.random().toString(36).slice(2, 10)

export function newSession(serverNowMs: number): DJSession {
  return { v: 1, sid: rid(), playing: true, seed: (Math.random() * 4294967296) >>> 0, band: FIXED_BAND, t0: serverNowMs + 1500, log: [] }
}

export class SyncedTechno {
  readonly events: StepEvent[] = []
  onEnded: ((sid: string) => void) | null = null
  private f: LazyAudio | null = null
  private eng: any = null
  private session: DJSession = IDLE_SESSION
  private applied = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private status: SyncState['status'] = 'idle'
  private offset = 0
  private origin = 0
  private samples: number[] = []
  private lastMeasure = 0
  private message = ''
  private resyncs = 0
  private ffSteps = 0
  private needRebuild = false
  private prevBrk = false
  /** DEV only: [step, serverMs, signature, live] per scheduled step */
  readonly dbg: [number, number, string, number][] = []

  constructor(readonly ctx: AudioContext, private dest: AudioNode, private clock: () => number) {}

  get joined() {
    return this.status !== 'idle'
  }
  get sid() {
    return this.session.sid
  }
  get isClosing() {
    return !!(this.eng && this.eng.cond.closing)
  }

  /** server seconds minus audio seconds, as heard at the output */
  private sampleOffset(): number {
    const pn = performance.now()
    const srv = this.clock()
    const ts = (this.ctx as any).getOutputTimestamp ? this.ctx.getOutputTimestamp() : null
    if (ts && ts.performanceTime && ts.contextTime) {
      const srvAtOut = srv - (pn - ts.performanceTime)
      return srvAtOut / 1000 - ts.contextTime
    }
    const lat = (this.ctx as any).outputLatency || this.ctx.baseLatency || 0
    return srv / 1000 - this.ctx.currentTime + lat
  }
  private measuredOffset() {
    this.samples.push(this.sampleOffset())
    if (this.samples.length > 7) this.samples.shift()
    const a = [...this.samples].sort((x, y) => x - y)
    return a[Math.floor(a.length / 2)]
  }
  /** the server clock jumped (XRift timeJumpCount changed): re-measure from scratch */
  clockJumped() {
    this.samples = []
    this.lastMeasure = 0
  }

  /** join the shared session (requires a running AudioContext) */
  join(session: DJSession) {
    this.stopLocal(false)
    if (!session.playing) return
    this.session = session
    this.applied = new Set()
    this.dbg.length = 0
    this.prevBrk = false
    resetS(session.band)
    const f = new LazyAudio(this.ctx)
    f.live = false
    this.samples = []
    for (let i = 0; i < 3; i++) this.offset = this.measuredOffset()
    this.origin = session.t0 / 1000 - this.offset
    // construction happens "before time": `.value =` assignments in the constructor must not
    // override the engine's setValueAtTime(v, 0) calls (as with a real, fresh AudioContext)
    f.virtualTime = -1e9
    const eng = new Engine(f, session.seed, { opening: false, dest: this.dest })
    f.virtualTime = this.origin
    eng.cond.auto = true
    eng.nextTime = this.origin
    eng.onStep = (_s: number, t: number, ev: any, bar: number) => {
      if (import.meta.env.DEV) {
        this.dbg.push([eng.step, Math.round((t + this.offset) * 1000), `${+ev.kick || 0}${+ev.hat ? 1 : 0}${+ev.clap ? 1 : 0}${+ev.bass ? 1 : 0}${+ev.stab ? 1 : 0}|${eng.low.style}|${eng.cond.p.energy.toFixed(3)}|${eng.bpm.toFixed(3)}`, f.live ? 1 : 0])
        if (this.dbg.length > 20000) this.dbg.shift()
      }
      const D = eng.drop
      const brk = !!D.active
      const drop = this.prevBrk && !brk
      this.prevBrk = brk
      if (!f.live) return
      const C = eng.cond
      this.events.push({
        t, bar, step: eng.step, kick: +ev.kick || 0, hat: +ev.hat || 0, clap: +ev.clap || 0, bass: +ev.bass || 0, stab: +ev.stab || 0,
        perc: +ev.perc || 0, fill: +ev.fill || 0, brk, kickOut: !!ev.drop, riser: brk && !!D.riserOn,
        brkProg: brk && D.len > 0 ? Math.max(0, Math.min(1, (bar - D.startBar + (eng.step % 16) / 16) / D.len)) : 0,
        drop, energy: C.p.energy, tension: C.p.tension, chill: !!eng.chillMode,
      })
      if (this.events.length > 256) this.events.splice(0, this.events.length - 256)
    }
    this.f = f
    this.eng = eng
    this.status = 'syncing'
    this.ffSteps = 0
    this.message = '同期中…'
    this.timer = setInterval(this.tick, TICK_MS)
    this.tick()
  }

  /** new shared state from the instance */
  update(session: DJSession) {
    if (!this.joined) {
      this.session = session
      return
    }
    if (!session.playing || session.sid !== this.session.sid) {
      this.stopLocal(true)
      this.session = session
      return
    }
    this.session = session
    if (this.eng) for (const e of session.log) if (!this.applied.has(e.id) && e.step < this.eng.step) this.needRebuild = true
  }

  private apply(e: DJEvent) {
    const C = this.eng.cond
    const labels: string[] = []
    if (e.kind === 'intent' && e.arg) {
      const res = C.intent(e.arg)
      labels.push(...(res.labels || []))
    } else if (e.kind === 'break') {
      C.hold = false
      C.curSrc = 'ボタン「ブレイク」'
      C.planBreak(C.bar, null, labels, null, e.arg || null, {})
      C.curSrc = null
    } else if (e.kind === 'band' && e.arg && BANDS[e.arg]) {
      const res = C.intent(BANDS[e.arg].ja + 'で')
      labels.push(...(res.labels || []))
    } else if (e.kind === 'stop') {
      C.curSrc = 'ストップ'
      C.startClosing(labels)
      C.curSrc = null
    }
    this.applied.add(e.id)
    if (labels.length) this.message = labels.join(' ・ ')
  }

  private stepOnce() {
    const eng = this.eng
    const f = this.f!
    if (!f.live) f.virtualTime = eng.nextTime
    for (const e of this.session.log) if (e.step === eng.step && !this.applied.has(e.id)) this.apply(e)
    eng.scheduleStep(eng.nextTime)
    eng.nextTime += eng.s16
    if (!f.live && ++this.ffSteps % 256 === 0) f.prunePending()
  }

  private tick = () => {
    if (!this.eng) return
    if (this.needRebuild) {
      this.needRebuild = false
      this.resyncs++
      const s = this.session
      this.join(s)
      this.message = '再同期しました'
      return
    }
    const now = this.ctx.currentTime
    // drift correction (server clock vs audio clock), once a second
    const pn = performance.now()
    if (pn - this.lastMeasure > 1000) {
      this.lastMeasure = pn
      const o = this.measuredOffset()
      if (this.samples.length >= 3 && Math.abs(o - this.offset) > DRIFT_LIMIT) {
        const delta = this.offset - o
        this.offset = o
        this.origin += delta
        this.eng.nextTime += delta
        this.resyncs++
      }
    }
    const f = this.f!
    const eng = this.eng
    // behind the timeline (late join / throttled tab): catch up silently, time-sliced
    if (eng.nextTime < now - 0.05) {
      f.live = false
      const t0 = performance.now()
      while (eng.nextTime < this.ctx.currentTime + LOOKAHEAD && performance.now() - t0 < 12) this.stepOnce()
      if (eng.nextTime < this.ctx.currentTime + LOOKAHEAD) return // continue on the next tick
      f.goLive()
    } else if (!f.live) f.goLive()
    if (this.status === 'syncing') {
      this.status = 'live'
      this.message = this.ffSteps ? `途中参加：${this.ffSteps}ステップ早送りして同期` : '同期して再生中'
    }
    while (eng.nextTime < this.ctx.currentTime + LOOKAHEAD) this.stepOnce()
    if (eng.closed && eng.closeDoneT != null && now >= eng.closeDoneT) {
      const sid = this.session.sid
      this.stopLocal(true)
      this.message = 'クロージング完了'
      if (this.onEnded) this.onEnded(sid)
    }
  }

  /** AudioContext time currently reaching the listener's ears (scheduled time minus output latency) */
  audibleTime(): number {
    const ts = (this.ctx as any).getOutputTimestamp ? this.ctx.getOutputTimestamp() : null
    if (ts && ts.performanceTime && ts.contextTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000
    return this.ctx.currentTime - ((this.ctx as any).outputLatency || this.ctx.baseLatency || 0)
  }

  /** step index (on a beat) at which a press made now should take effect for everyone */
  eventStep(): number {
    const eng = this.eng
    if (!eng) return 0
    const ahead = Math.max(0, this.ctx.currentTime + EVENT_LEAD - eng.nextTime)
    let s = eng.step + Math.ceil(ahead / eng.s16)
    s = Math.ceil(s / 4) * 4
    return s
  }

  makeEvent(kind: DJEventKind, arg: string | null = null): DJEvent {
    return { id: rid(), step: this.eventStep(), kind, arg }
  }

  nextBand(): BandId {
    const cur = (this.eng ? this.eng.cond.pendingBand || this.eng.cond.band : this.session.band) as BandId
    return BAND_ORDER[(BAND_ORDER.indexOf(cur) + 1) % BAND_ORDER.length]
  }

  stopLocal(fade: boolean) {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const e = this.eng
    if (e && this.f) {
      const t = this.ctx.currentTime
      this.f.live = true
      e.out.gain.setTargetAtTime(0, t, fade ? 0.05 : 0.01)
      e.riserBus.gain.setTargetAtTime(0, t, 0.02)
      e.dispose(t + 0.4)
      setTimeout(() => {
        try { e.out.disconnect(); e.riserBus.disconnect() } catch { /* gone */ }
      }, 600)
    }
    this.eng = null
    this.f = null
    this.events.length = 0
    this.status = 'idle'
  }

  getState(): SyncState {
    const e = this.eng
    const base = { offsetMs: Math.round(this.offset * 1000), resyncs: this.resyncs, ffSteps: this.ffSteps, message: this.message }
    if (!e) {
      const b = BANDS[this.session.band] || BANDS[FIXED_BAND]
      return { ...base, status: 'idle', closing: false, bpm: b.start, band: b.ja, bandId: this.session.band, style: '', phase: '', bar: 0, step: 0 }
    }
    const C = e.cond
    const cur = C.set && C.set.list[C.set.idx]
    const phase = C.closing ? PHASE_JA.closing : C.opening ? PHASE_JA.opening : C.chill && C.chill.state !== 'planned' ? PHASE_JA.chill : cur ? phJa(cur.phase, C.band) : ''
    const band = BANDS[C.band].ja + (C.pendingBand ? ' → ' + BANDS[C.pendingBand].ja : '')
    return { ...base, status: this.status, closing: !!C.closing, bpm: e.bpm, band, bandId: C.band, style: C.ja(e.low.style), phase, bar: e.bar, step: e.step }
  }

  /** debug signature of the engine state (for multi-client tests) */
  debugInfo() {
    const e = this.eng
    if (!e) return null
    return { step: e.step, bar: e.bar, bpm: e.bpm, key: e.key, style: e.low.style, band: e.cond.band, energy: e.cond.p.energy, nextRel: e.nextTime - this.origin, applied: [...this.applied] }
  }

  dispose() {
    this.stopLocal(false)
  }
}
