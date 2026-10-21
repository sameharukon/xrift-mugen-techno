/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Perpetual, clock-derived techno (no shared state, no start / stop, no audible restarts).
 *
 * The music is a pure function of the server clock: time since a fixed EPOCH is cut into
 * segments of SEG_MS. Segment k is one engine run seeded by seedOf(k) that starts at
 * T_k = EPOCH + k·SEG_MS directly in a running groove (no opening). The engine is deterministic for
 * a given seed, so every client renders the same steps at the same server time, and a late joiner
 * only replays (silently, LazyAudio) the current segment: the fast-forward is bounded by one segment.
 *
 * Seamless boundaries: during the last APPROACH_S of a segment its conductor is steered, all
 * deterministically from the segment's own timeline, toward the state the next segment starts in:
 *  - autopilot on hold (no new mixes / chill episodes), a DJ mix into the start style and home key,
 *  - energy glides to the next segment's start energy,
 *  - tempo glides bar by bar to the next segment's start BPM, with the bar count solved so the last
 *    bar ends exactly on T_{k+1} (beat grid continues across the boundary),
 *  - a 1-bar kick drop (bass keeps playing) with a fill ends on T_{k+1}: the next downbeat is the return.
 * The old segment stops scheduling at that bar (its tails ring out, no fade); the new one starts on
 * the same grid at the same tempo, style and energy.
 *
 * Each client maps server time → its AudioContext time (XRift server clock + getOutputTimestamp)
 * and re-measures that offset once a second (drift correction).
 */
import { Engine, BANDS, S, resetS } from './engine'
import { LazyAudio } from './lazyAudio'

export const FIXED_BAND = 'b140'
/** fixed origin of the perpetual timeline (server clock, ms) */
export const EPOCH_MS = Date.UTC(2026, 0, 1)
/** segment length (ms): bounds the late-join fast-forward */
export const SEG_MS = 10 * 60 * 1000
/** steering window before a boundary (s) */
export const APPROACH_S = 120
/** old segment tails (reverb / delay) ring out this long after its last step (s) */
const TAIL_S = 5
/** next segment's start state (Engine without opening: band start tempo, band's first style, profile energy) */
const START_BPM = (BANDS[FIXED_BAND] as { start: number }).start
const START_STYLE = (BANDS[FIXED_BAND] as { first: string }).first
const START_ENERGY = 0.71
/** every segment starts in the home key (A minor); the approach mix of the previous segment lands there */
const START_KEY = 9
/** short kick drop into the boundary (bars; kick only, bass and the rest keep playing) */
const BRIDGE_BARS = 1
/** the approach mix must start at least this many bars before the boundary */
const MIX_LEAD_BARS = 40

export const segIndexAt = (serverMs: number) => Math.floor((serverMs - EPOCH_MS) / SEG_MS)
export const segStartMs = (k: number) => EPOCH_MS + k * SEG_MS
/** deterministic 32-bit seed per segment (integer hash) */
export function seedOf(k: number): number {
  let h = (k | 0) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

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
  brk: boolean
  kickOut: boolean
  riser: boolean
  brkProg: number
  drop: boolean
  energy: number
  tension: number
  chill: boolean
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'live'
  seg: number
  bpm: number
  bar: number
  step: number
  offsetMs: number
  resyncs: number
  rejoins: number
  ffSteps: number
  ffMs: number
}

const LOOKAHEAD = 0.25
const TICK_MS = 25
const DRIFT_LIMIT = 0.03
/** offset change beyond this (s) is a discontinuity (AudioContext suspended / interrupted, long main-thread stall), not drift */
const JUMP_LIMIT = 0.25
/** live scheduling fell this far behind the audio clock (s) → re-join instead of replaying the backlog */
const BEHIND_LIMIT = 0.5
/** create the next segment's engine this long before it starts (construction off the beat) */
const PREP_S = 3
/** FF time slice per tick (ms) so the main thread stays responsive */
const SLICE_MS = 12

interface Seg {
  k: number
  f: LazyAudio
  eng: any
  gain: GainNode
  /** audio time of T_k */
  origin: number
  /** audio time the next segment takes over (visual handoff, start of the fade) */
  endT: number
  /** audio time scheduling stops (end of the fade) */
  stopT: number
  /** engine-global settings that the engine mutates (S is module-global, shared by all engines) */
  key: number
  band: string
  prevBrk: boolean
  started: boolean
  ff: number
  /** engine-timeline seconds since T_k (sum of step lengths: identical on every client) */
  rel: number
  /** approach plan: first bar, per-bar BPM, the bar the segment ends at (= T_{k+1}) */
  plan: { b0: number; bpm: number[]; endBar: number } | null
  /** the approach mix into the start style / key has been planned */
  mixed: boolean
}

/** tempo for each of n bars: from c to B (last bar exactly B), smooth bump d solved so the bars sum to R seconds */
function tempoPlan(c: number, B: number, n: number, R: number): number[] {
  const mk = (d: number) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n; return c + (B - c) * u + 4 * d * u * (1 - u) })
  const dur = (a: number[]) => a.reduce((x, b) => x + 240 / b, 0)
  let lo = -20, hi = 20
  for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (dur(mk(m)) > R) lo = m; else hi = m }
  return mk((lo + hi) / 2)
}

export class PerpetualTechno {
  readonly events: StepEvent[] = []
  private segs: Seg[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private status: SyncState['status'] = 'idle'
  private offset = 0
  private samples: number[] = []
  private lastMeasure = 0
  private resyncs = 0
  private rejoins = 0
  /** the AudioContext was not running (suspended / interrupted) since the last tick */
  private stalled = false
  private ffSteps = 0
  private ffStart = 0
  private ffMs = 0
  /** DEV only: [seg, step, serverMs, signature, live] per scheduled step */
  readonly dbg: [number, number, number, string, number][] = []

  constructor(readonly ctx: AudioContext, private dest: AudioNode, private clock: () => number) {}

  get running() {
    return this.timer !== null
  }

  /** server seconds minus audio seconds, as heard at the output */
  private sampleOffset(): number {
    const pn = performance.now()
    const srv = this.clock()
    const ts = (this.ctx as any).getOutputTimestamp ? this.ctx.getOutputTimestamp() : null
    if (ts && ts.performanceTime && ts.contextTime) return (srv - (pn - ts.performanceTime)) / 1000 - ts.contextTime
    const lat = (this.ctx as any).outputLatency || this.ctx.baseLatency || 0
    return srv / 1000 - this.ctx.currentTime + lat
  }
  private measuredOffset() {
    this.samples.push(this.sampleOffset())
    if (this.samples.length > 7) this.samples.shift()
    const a = [...this.samples].sort((x, y) => x - y)
    return a[Math.floor(a.length / 2)]
  }
  clockJumped() {
    this.samples = []
    this.lastMeasure = 0
  }

  /** start following the perpetual timeline (needs a running AudioContext) */
  start() {
    if (this.timer) return
    this.samples = []
    for (let i = 0; i < 3; i++) this.offset = this.measuredOffset()
    this.status = 'syncing'
    this.ffSteps = 0
    this.ffStart = performance.now()
    this.timer = setInterval(this.tick, TICK_MS)
    this.tick()
  }

  private makeSeg(k: number): Seg {
    const origin = segStartMs(k) / 1000 - this.offset
    const gain = this.ctx.createGain()
    gain.gain.value = 1
    gain.connect(this.dest)
    resetS(FIXED_BAND)
    const f = new LazyAudio(this.ctx)
    f.live = false
    // construction happens "before time" (see LazyAudio): constructor `.value =` must not override setValueAtTime(v, 0)
    f.virtualTime = -1e9
    const eng = new Engine(f, seedOf(k), { opening: false, key: START_KEY, dest: gain })
    f.virtualTime = origin
    eng.cond.auto = true
    eng.nextTime = origin
    const seg: Seg = { k, f, eng, gain, origin, endT: Infinity, stopT: Infinity, key: S.key, band: S.band, prevBrk: false, started: false, ff: 0, rel: 0, plan: null, mixed: false }
    eng.onStep = (_s: number, t: number, ev: any, bar: number) => {
      if (import.meta.env.DEV) {
        this.dbg.push([k, eng.step, Math.round((t + this.offset) * 1000), `${+ev.kick || 0}${+ev.hat ? 1 : 0}${+ev.clap ? 1 : 0}${+ev.bass ? 1 : 0}${+ev.stab ? 1 : 0}|${eng.low.style}|${eng.cond.p.energy.toFixed(3)}|${eng.bpm.toFixed(3)}|${eng.key}`, f.live ? 1 : 0])
        if (this.dbg.length > 40000) this.dbg.splice(0, 10000)
      }
      const D = eng.drop
      const brk = !!D.active
      const drop = seg.prevBrk && !brk
      seg.prevBrk = brk
      if (!f.live || t >= seg.endT) return
      const C = eng.cond
      this.events.push({
        t, bar, step: eng.step, kick: +ev.kick || 0, hat: +ev.hat || 0, clap: +ev.clap || 0, bass: +ev.bass || 0, stab: +ev.stab || 0,
        perc: +ev.perc || 0, fill: +ev.fill || 0, brk, kickOut: !!ev.drop, riser: brk && !!D.riserOn,
        brkProg: brk && D.len > 0 ? Math.max(0, Math.min(1, (bar - D.startBar + (eng.step % 16) / 16) / D.len)) : 0,
        drop, energy: C.p.energy, tension: C.p.tension, chill: !!eng.chillMode,
      })
      if (this.events.length > 256) this.events.splice(0, this.events.length - 256)
    }
    return seg
  }

  /** deterministic steering toward the next segment's start state (runs at bar starts, before the bar is scheduled) */
  private approach(g: Seg) {
    const eng = g.eng
    const C = eng.cond
    const bar = eng.step / 16
    if (!g.plan) {
      const R = SEG_MS / 1000 - g.rel
      if (R > APPROACH_S) return
      const c = eng.bpm
      const n = Math.max(BRIDGE_BARS + 2, Math.round((R * (c + START_BPM)) / 2 / 240))
      g.plan = { b0: bar, bpm: tempoPlan(c, START_BPM, n, R), endBar: bar + n }
      C.hold = true
      C.queue = []
      // any deck that comes in from now on is in the next segment's key
      eng.nextKey = () => START_KEY
      C.setParam('energy', START_ENERGY, Math.max(8, Math.min(48, n - 8)), bar)
    }
    const P = g.plan
    // DJ mix into the next segment's start style + key, as soon as nothing else is mixing
    if (!g.mixed && bar <= P.endBar - MIX_LEAD_BARS && !C.mix && !C.chill && !C.pendingBand && !eng.drop.active && eng.decks.length === 1) {
      g.mixed = true
      C.planMix(START_STYLE, bar, {})
    }
    const i = bar - P.b0
    if (i >= 0 && i < P.bpm.length) eng.bpmGlide = { b0: bar, bars: 1, from: P.bpm[i], to: P.bpm[i], label: null, src: null }
    if (bar === P.endBar - BRIDGE_BARS - 1 && !eng.drop.active) {
      C.events = C.events.filter((x: any) => !((x.type === 'break' || x.type === 'drop') && x.bar >= bar))
      const R = C.kickRecipe({ len: BRIDGE_BARS })
      R.remove = 'kick'
      R.micro = 0
      C.planBreak(bar, BRIDGE_BARS, [], 1, 'kick', { recipe: R })
    }
  }

  private stepOnce(g: Seg) {
    const eng = g.eng
    if (!g.f.live) g.f.virtualTime = eng.nextTime
    S.key = g.key
    S.band = g.band
    if (eng.step % 16 === 0) this.approach(g)
    eng.scheduleStep(eng.nextTime)
    g.key = S.key
    g.band = S.band
    g.rel += eng.s16
    eng.nextTime += eng.s16
    if (!g.f.live) {
      this.ffSteps++
      if (++g.ff % 256 === 0) g.f.prunePending()
    }
  }

  private dropSeg(g: Seg, fadeAt: number | null) {
    const t = this.ctx.currentTime
    g.f.live = true
    if (fadeAt == null) g.gain.gain.setTargetAtTime(0, t, 0.03)
    g.eng.dispose(Math.max(t, fadeAt ?? t) + 0.4)
    setTimeout(() => {
      try { g.gain.disconnect() } catch { /* gone */ }
    }, Math.max(0, (Math.max(t, fadeAt ?? t) - t) * 1000) + 700)
  }

  /**
   * Clean re-join after a clock discontinuity: the old timeline is faded out (30 ms) and dropped together with its
   * queued light events, the offset is measured afresh and the current segment is rebuilt by the silent late-join
   * fast-forward. Without this, resuming a suspended AudioContext (headset menu / sleep, tab in the background) or
   * a long stall replayed the whole missed backlog live at once (hundreds of steps scheduled in the past → a burst
   * of sound and a burst of stale light events), and shifted engines kept stale absolute times.
   */
  private rejoin() {
    for (const g of this.segs) this.dropSeg(g, null)
    this.segs = []
    this.events.length = 0
    this.samples = []
    for (let i = 0; i < 3; i++) this.offset = this.measuredOffset()
    this.lastMeasure = performance.now()
    this.status = 'syncing'
    this.ffSteps = 0
    this.ffStart = performance.now()
    this.rejoins++
  }

  private tick = () => {
    if (this.ctx.state !== 'running') { this.stalled = true; return }
    if (this.stalled) { this.stalled = false; this.rejoin() }
    const now = this.ctx.currentTime
    const pn = performance.now()
    if (pn - this.lastMeasure > 1000) {
      this.lastMeasure = pn
      const raw = this.sampleOffset()
      // a fresh sample far off the current offset = discontinuity (the median filter would take seconds to follow)
      if (this.samples.length >= 3 && Math.abs(raw - this.offset) > JUMP_LIMIT && Math.abs(this.sampleOffset() - this.offset) > JUMP_LIMIT) { this.rejoin(); return }
      const o = this.measuredOffset()
      if (this.samples.length >= 3 && Math.abs(o - this.offset) > DRIFT_LIMIT) {
        const delta = this.offset - o
        this.offset = o
        for (const g of this.segs) { g.origin += delta; g.endT += delta; g.stopT += delta; g.eng.nextTime += delta }
        this.resyncs++
      }
    }
    const horizon = now + LOOKAHEAD
    const kNow = segIndexAt((now + this.offset) * 1000)
    // drop segments that are completely in the past (throttled tab / first join)
    for (const g of [...this.segs]) if (g.stopT < now || g.k < kNow - 1) { this.segs.splice(this.segs.indexOf(g), 1); this.dropSeg(g, null) }
    if (!this.segs.length) this.segs.push(this.makeSeg(kNow))
    const last = this.segs[this.segs.length - 1]
    const nextOrigin = segStartMs(last.k + 1) / 1000 - this.offset
    if (nextOrigin < horizon + PREP_S) {
      // hand over on the shared grid: the old segment's last (steered) bar ends exactly at T_{k+1}
      last.endT = nextOrigin
      last.stopT = nextOrigin + TAIL_S
      this.segs.push(this.makeSeg(last.k + 1))
      return // construction is heavy: schedule on the next tick
    }
    // live scheduling fell far behind the audio clock (main thread stalled while audio kept running) → re-join
    if (this.status === 'live' && this.segs.some((g) => g.started && this.canStep(g) && g.eng.nextTime < now - BEHIND_LIMIT)) { this.rejoin(); return }
    // silent fast-forward of a segment that is behind (late join), time-sliced
    const t0 = performance.now()
    for (const g of this.segs) {
      if (g.started || g.eng.nextTime >= now - 0.05) continue
      const lim = () => this.ctx.currentTime + LOOKAHEAD
      while (this.canStep(g) && g.eng.nextTime < lim() && performance.now() - t0 < SLICE_MS) this.stepOnce(g)
      if (this.canStep(g) && g.eng.nextTime < lim()) return // continue next tick
      g.f.goLive()
      g.started = true
    }
    // live scheduling, in time order across segments
    for (;;) {
      let best: Seg | null = null
      for (const g of this.segs) {
        const n = g.eng.nextTime
        if (n < horizon && this.canStep(g) && (!best || n < best.eng.nextTime)) best = g
      }
      if (!best) break
      if (!best.started) {
        best.f.goLive(); best.started = true
        // continuity of the drop detection across the boundary (old segment ended in its kick-out)
        const prev = this.segs.find((x) => x.k === best!.k - 1)
        if (prev && best.eng.step === 0) best.prevBrk = prev.prevBrk
      }
      this.stepOnce(best)
    }
    if (this.status === 'syncing' && this.segs.every((g) => g.started || g.eng.nextTime >= horizon)) {
      this.status = 'live'
      this.ffMs = Math.round(performance.now() - this.ffStart)
    }
  }

  /** the segment still has steps to play: up to its planned end bar (= T_{k+1}); time cut as a fallback */
  private canStep(g: Seg) {
    if (g.plan && isFinite(g.endT)) return g.eng.step < g.plan.endBar * 16
    return g.eng.nextTime < g.endT - 1e-6
  }

  /** AudioContext time currently reaching the listener's ears */
  audibleTime(): number {
    const ts = (this.ctx as any).getOutputTimestamp ? this.ctx.getOutputTimestamp() : null
    if (ts && ts.performanceTime && ts.contextTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000
    return this.ctx.currentTime - ((this.ctx as any).outputLatency || this.ctx.baseLatency || 0)
  }

  /** the segment currently leading (the newest one that has started) */
  private lead(): Seg | null {
    const a = this.audibleTime()
    for (let i = this.segs.length - 1; i >= 0; i--) if (this.segs[i].origin <= a) return this.segs[i]
    return this.segs[0] || null
  }

  getState(): SyncState {
    const g = this.lead()
    const base = { offsetMs: Math.round(this.offset * 1000), resyncs: this.resyncs, rejoins: this.rejoins, ffSteps: this.ffSteps, ffMs: this.ffMs }
    if (!g) return { ...base, status: this.status === 'syncing' ? 'syncing' : 'idle', seg: -1, bpm: BANDS[FIXED_BAND].start, bar: 0, step: 0 }
    return { ...base, status: this.status, seg: g.k, bpm: g.eng.bpm, bar: g.eng.bar, step: g.eng.step }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const g of this.segs) this.dropSeg(g, null)
    this.segs = []
    this.events.length = 0
    this.status = 'idle'
  }

  dispose() {
    this.stop()
  }
}
