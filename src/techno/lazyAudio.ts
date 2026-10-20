/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lazy Web Audio facade.
 *
 * The engine talks to this facade instead of a real AudioContext. Every node is a lightweight
 * wrapper that records its properties, AudioParam automation and connections. A wrapper only
 * creates the real Web Audio node ("materializes") when it can actually be heard:
 *  - a source node is started while the facade is live, or
 *  - a materialized node connects into it.
 *
 * While `live` is false (silent fast-forward for late joiners) nothing is materialized and the
 * scheduler can run the engine over past (even negative) times at full speed. When going live,
 * `goLive()` materializes every source that is still sounding, replaying the automation from
 * the current time on. This is what lets a late joiner reproduce the exact generator state.
 */

type Ev =
  | { type: 'set'; time: number; value: number }
  | { type: 'lin' | 'exp'; time: number; value: number }
  | { type: 'target'; time: number; value: number; tau: number }
  | { type: 'curve'; time: number; value: number; dur: number; curve: Float32Array | number[] }

const PARAMS: Record<string, Record<string, number>> = {
  Gain: { gain: 1 },
  BiquadFilter: { frequency: 350, Q: 1, gain: 0, detune: 0 },
  Oscillator: { frequency: 440, detune: 0 },
  BufferSource: { playbackRate: 1, detune: 0 },
  ConstantSource: { offset: 1 },
  Delay: { delayTime: 0 },
  StereoPanner: { pan: 0 },
  DynamicsCompressor: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
  WaveShaper: {},
  Convolver: {},
}
const SOURCES = new Set(['Oscillator', 'BufferSource', 'ConstantSource'])
const PROPS = ['type', 'buffer', 'curve', 'oversample', 'loop', 'loopStart', 'loopEnd', 'normalize', 'onended']

const clampT = (t: number) => (t > 0 ? t : 0)

export class ParamW {
  real: AudioParam | null = null
  ev: Ev[]
  constructor(readonly owner: NodeW, readonly name: string, def: number) {
    this.ev = [{ type: 'set', time: -1e9, value: def }]
  }
  private add(e: Ev) {
    let i = this.ev.length
    while (i > 0 && this.ev[i - 1].time > e.time) i--
    this.ev.splice(i, 0, e)
    if (this.ev.length > 48) this.prune()
  }
  /** collapse old history into one 'set' event at a safe boundary (set / ramp end) */
  private prune() {
    const keep = this.ev.length - 16
    for (let k = keep; k > 0; k--) {
      const e = this.ev[k]
      if (e.type === 'set' || e.type === 'lin' || e.type === 'exp') {
        this.ev.splice(0, k + 1, { type: 'set', time: e.time, value: e.value })
        return
      }
    }
  }
  valueAt(T: number): number {
    let v = this.ev[0].value
    let pt = this.ev[0].time
    let tgt: Extract<Ev, { type: 'target' }> | null = null
    for (const e of this.ev) {
      if (e.time > T) {
        if (tgt) v = tgt.value + (v - tgt.value) * Math.exp(-(T - pt) / tgt.tau)
        if (e.type === 'lin') return v + ((e.value - v) * (T - pt)) / (e.time - pt)
        if (e.type === 'exp') return v > 0 === e.value > 0 && v !== 0 ? v * Math.pow(e.value / v, (T - pt) / (e.time - pt)) : v
        return v
      }
      if (tgt) v = tgt.value + (v - tgt.value) * Math.exp(-(e.time - pt) / tgt.tau)
      tgt = null
      if (e.type === 'target') tgt = e
      else if (e.type === 'curve') {
        const end = e.time + e.dur
        if (T < end) {
          const c = e.curve, f = ((T - e.time) / e.dur) * (c.length - 1), i = Math.floor(f)
          return c[i] + (c[Math.min(c.length - 1, i + 1)] - c[i]) * (f - i)
        }
        v = e.curve[e.curve.length - 1]
        pt = end
        continue
      } else v = e.value
      pt = e.time
    }
    if (tgt) v = tgt.value + (v - tgt.value) * Math.exp(-(T - pt) / tgt.tau)
    return v
  }
  get value() {
    return this.real ? this.real.value : this.valueAt(this.owner.f.currentTime)
  }
  set value(v: number) {
    if (this.real) this.real.value = v
    else this.add({ type: 'set', time: this.owner.f.currentTime, value: v })
  }
  get defaultValue() {
    return this.ev[0].value
  }
  setValueAtTime(v: number, t: number) {
    if (this.real) this.real.setValueAtTime(v, clampT(t))
    else this.add({ type: 'set', time: t, value: v })
    return this
  }
  linearRampToValueAtTime(v: number, t: number) {
    if (this.real) this.real.linearRampToValueAtTime(v, clampT(t))
    else this.add({ type: 'lin', time: t, value: v })
    return this
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (this.real) this.real.exponentialRampToValueAtTime(v, clampT(t))
    else this.add({ type: 'exp', time: t, value: v })
    return this
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    if (this.real) this.real.setTargetAtTime(v, clampT(t), tau)
    else this.add({ type: 'target', time: t, value: v, tau })
    return this
  }
  setValueCurveAtTime(curve: Float32Array | number[], t: number, dur: number) {
    if (this.real) this.real.setValueCurveAtTime(curve, clampT(t), dur)
    else this.add({ type: 'curve', time: t, value: curve[curve.length - 1], dur, curve })
    return this
  }
  cancelScheduledValues(t: number) {
    if (this.real) this.real.cancelScheduledValues(clampT(t))
    else {
      this.ev = this.ev.filter((e, i) => i === 0 || e.time < t)
    }
    return this
  }
  cancelAndHoldAtTime(t: number) {
    if (this.real) {
      const p = this.real as any
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(clampT(t))
      else { const v = p.value; p.cancelScheduledValues(clampT(t)); p.setValueAtTime(v, clampT(t)) }
    } else {
      const v = this.valueAt(t)
      this.ev = this.ev.filter((e, i) => i === 0 || e.time < t)
      this.add({ type: 'set', time: t, value: v })
    }
    return this
  }
  /** attach to the real AudioParam: current value at `now`, then the remaining automation */
  materialize(real: AudioParam, now: number) {
    this.real = real
    const v = this.valueAt(now)
    real.cancelScheduledValues(0)
    real.value = v
    real.setValueAtTime(v, now)
    let last: Ev | null = null
    for (const e of this.ev) if (e.time <= now) last = e
    if (last && last.type === 'target') real.setTargetAtTime(last.value, now, last.tau)
    if (last && last.type === 'curve' && last.time + last.dur > now) {
      const c = last.curve, f = (now - last.time) / last.dur, from = Math.floor(f * (c.length - 1))
      const rest = Array.from(c).slice(from)
      if (rest.length >= 2) real.setValueCurveAtTime(rest, now, last.time + last.dur - now)
    }
    for (const e of this.ev) {
      if (e.time <= now) continue
      if (e.type === 'set') real.setValueAtTime(e.value, e.time)
      else if (e.type === 'lin') real.linearRampToValueAtTime(e.value, e.time)
      else if (e.type === 'exp') real.exponentialRampToValueAtTime(e.value, e.time)
      else if (e.type === 'target') real.setTargetAtTime(e.value, e.time, e.tau)
      else if (e.type === 'curve') real.setValueCurveAtTime(e.curve, e.time, e.dur)
    }
    this.ev = this.ev.slice(0, 1)
  }
}

type Dest = NodeW | ParamW | AudioNode
interface Conn { d: Dest; o?: number; i?: number }

export class NodeW {
  real: AudioNode | null = null
  conns: Conn[] = []
  props = new Map<string, unknown>()
  params: Record<string, ParamW> = {}
  startT: number | null = null
  startOff = 0
  stopT: number | null = null
  isSource: boolean
  constructor(readonly f: LazyAudio, readonly kind: string, readonly args: unknown[]) {
    this.isSource = SOURCES.has(kind)
    for (const [k, v] of Object.entries(PARAMS[kind] || {})) {
      const p = new ParamW(this, k, v)
      this.params[k] = p
      ;(this as any)[k] = p
    }
  }
  get reduction() {
    return this.real ? (this.real as DynamicsCompressorNode).reduction : 0
  }
  connect(d: Dest, o?: number, i?: number) {
    this.conns.push({ d, o, i })
    if (this.real) this.f.link(this, { d, o, i })
    return d
  }
  disconnect(d?: Dest) {
    if (d === undefined) {
      this.conns = []
      if (this.real) try { this.real.disconnect() } catch { /* not connected */ }
      return
    }
    this.conns = this.conns.filter((c) => c.d !== d)
    if (this.real) {
      const rd = d instanceof NodeW ? d.real : d instanceof ParamW ? d.real : d
      if (rd) try { (this.real as any).disconnect(rd) } catch { /* not connected */ }
    }
  }
  start(t = 0, off = 0) {
    this.startT = t
    this.startOff = off
    if (this.real) (this.real as AudioScheduledSourceNode & { start: (a: number, b?: number) => void }).start(clampT(t), off || undefined)
    else if (this.f.live) this.f.materialize(this)
    else this.f.pending.add(this)
  }
  stop(t = 0) {
    this.stopT = t
    if (this.real) try { (this.real as AudioScheduledSourceNode).stop(clampT(t)) } catch { /* not started */ }
  }
  listeners: [string, EventListener][] = []
  addEventListener(type: string, fn: EventListener) {
    this.listeners.push([type, fn])
    if (this.real) this.real.addEventListener(type, fn)
  }
  removeEventListener(type: string, fn: EventListener) {
    this.listeners = this.listeners.filter(([t, f]) => t !== type || f !== fn)
    if (this.real) this.real.removeEventListener(type, fn)
  }
  setPeriodicWave(w: PeriodicWave) {
    this.props.set('__wave', w)
    if (this.real) (this.real as OscillatorNode).setPeriodicWave(w)
  }
  /** a lazily started source that has certainly finished by time T */
  deadAt(T: number) {
    if (this.stopT != null && this.stopT <= T) return true
    if (this.kind === 'BufferSource' && !this.props.get('loop')) {
      const b = this.props.get('buffer') as AudioBuffer | undefined
      if (b && this.startT != null) {
        const rate = Math.max(0.01, this.params.playbackRate.valueAt(T))
        if (this.startT + (b.duration - this.startOff) / rate <= T) return true
      }
    }
    return false
  }
}
for (const p of PROPS) {
  Object.defineProperty(NodeW.prototype, p, {
    get(this: NodeW) {
      return this.props.get(p)
    },
    set(this: NodeW, v: unknown) {
      this.props.set(p, v)
      if (this.real) (this.real as any)[p] = v
    },
  })
}

export class LazyAudio {
  live = true
  virtualTime = 0
  pending = new Set<NodeW>()
  constructor(readonly ctx: AudioContext) {}
  get currentTime() {
    return this.live ? this.ctx.currentTime : this.virtualTime
  }
  get sampleRate() {
    return this.ctx.sampleRate
  }
  get destination() {
    return this.ctx.destination
  }
  createBuffer(ch: number, len: number, sr: number) {
    return this.ctx.createBuffer(ch, len, sr)
  }
  createPeriodicWave(re: Float32Array, im: Float32Array, o?: PeriodicWaveConstraints) {
    return this.ctx.createPeriodicWave(re, im, o)
  }
  private mk(kind: string, args: unknown[] = []) {
    return new NodeW(this, kind, args) as any
  }
  createGain() { return this.mk('Gain') }
  createBiquadFilter() { return this.mk('BiquadFilter') }
  createOscillator() { return this.mk('Oscillator') }
  createBufferSource() { return this.mk('BufferSource') }
  createConstantSource() { return this.mk('ConstantSource') }
  createDelay(max = 1) { return this.mk('Delay', [max]) }
  createStereoPanner() { return this.mk('StereoPanner') }
  createDynamicsCompressor() { return this.mk('DynamicsCompressor') }
  createWaveShaper() { return this.mk('WaveShaper') }
  createConvolver() { return this.mk('Convolver') }

  /** connect a materialized node's real output to dest (materializing dest on demand) */
  link(n: NodeW, c: Conn) {
    const real = n.real as any
    if (c.d instanceof NodeW) {
      if (!c.d.real) this.materialize(c.d)
      real.connect(c.d.real, c.o ?? 0, c.i ?? 0)
    } else if (c.d instanceof ParamW) {
      if (!c.d.owner.real) this.materialize(c.d.owner)
      real.connect(c.d.real, c.o ?? 0)
    } else real.connect(c.d, c.o ?? 0, c.i ?? 0)
  }

  materialize(n: NodeW) {
    if (n.real) return
    const now = this.ctx.currentTime
    const c = this.ctx as any
    const real = c['create' + n.kind](...n.args) as any
    n.real = real
    for (const [k, v] of n.props) {
      if (k === '__wave') real.setPeriodicWave(v)
      else real[k] = v
    }
    for (const [type, fn] of n.listeners) real.addEventListener(type, fn)
    for (const [k, p] of Object.entries(n.params)) p.materialize(real[k], now)
    for (const cn of n.conns) this.link(n, cn)
    if (n.isSource && n.startT != null) {
      if (n.startT >= now) real.start(n.startT, n.startOff || undefined)
      else if (n.kind === 'BufferSource') {
        const b = n.props.get('buffer') as AudioBuffer | undefined
        let off = n.startOff + (now - n.startT) * n.params.playbackRate.valueAt(now)
        if (b && n.props.get('loop')) off %= b.duration
        real.start(now, off)
      } else real.start(now)
      if (n.stopT != null) real.stop(Math.max(n.stopT, now))
    }
  }

  /** end of fast-forward: materialize every source that is still sounding */
  goLive() {
    this.live = true
    const now = this.ctx.currentTime
    for (const n of this.pending) if (!n.deadAt(now)) this.materialize(n)
    this.pending.clear()
  }

  /** drop finished sources during a long fast-forward so they can be garbage collected */
  prunePending() {
    const T = this.virtualTime
    for (const n of this.pending) if (n.deadAt(T)) this.pending.delete(n)
  }
}
