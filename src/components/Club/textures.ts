import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace } from 'three'

/** deterministic value noise → grey concrete albedo (generated in JS, no image asset) */
let concrete: DataTexture | null = null
export function concreteTexture(): DataTexture {
  if (concrete) return concrete
  const N = 128
  const d = new Uint8Array(N * N * 4)
  let seed = 1234567
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  const grid = 16
  const g: number[] = Array.from({ length: (grid + 1) * (grid + 1) }, rnd)
  const at = (x: number, y: number) => g[(y % grid) * (grid + 1) + (x % grid)]
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * grid, fy = (y / N) * grid
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), e = at(ix + 1, iy + 1)
      const low = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
      const v = 0.55 + 0.25 * low + 0.2 * rnd() // blotches + grain
      const c8 = Math.max(0, Math.min(255, Math.round(v * 255)))
      d.set([c8, c8, c8, 255], (y * N + x) * 4)
    }
  concrete = new DataTexture(d, N, N, RGBAFormat)
  concrete.wrapS = concrete.wrapT = RepeatWrapping
  concrete.colorSpace = SRGBColorSpace
  concrete.magFilter = LinearFilter
  concrete.needsUpdate = true
  return concrete
}

/** 1×64 vertical alpha ramp for beam cones: bright at the fixture (uv.y=1), fading towards the floor */
let beamRamp: DataTexture | null = null
export function beamAlphaTexture(): DataTexture {
  if (beamRamp) return beamRamp
  const N = 64
  const d = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    const v = i / (N - 1)
    const a = Math.round(255 * (0.08 + 0.92 * Math.pow(v, 1.8)))
    d.set([a, a, a, 255], i * 4)
  }
  beamRamp = new DataTexture(d, 1, N, RGBAFormat)
  beamRamp.magFilter = LinearFilter
  beamRamp.needsUpdate = true
  return beamRamp
}

/** radial falloff (floor glow pools) */
let radial: DataTexture | null = null
export function radialTexture(): DataTexture {
  if (radial) return radial
  const N = 64
  const d = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - (N - 1) / 2, y - (N - 1) / 2) / (N / 2)
      const a = Math.round(255 * Math.pow(Math.max(0, 1 - r), 2))
      d.set([a, a, a, 255], (y * N + x) * 4)
    }
  radial = new DataTexture(d, N, N, RGBAFormat)
  radial.magFilter = LinearFilter
  radial.needsUpdate = true
  return radial
}

/** procedural brick wall albedo (running bond, dark mortar, per-brick tone + grain) */
let brick: DataTexture | null = null
export function brickTexture(): DataTexture {
  if (brick) return brick
  const W = 256, H = 256
  const bw = 64, bh = 24, mortar = 3
  const d = new Uint8Array(W * H * 4)
  let seed = 98765
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  const tones: number[] = Array.from({ length: 64 }, () => 0.6 + 0.4 * rnd())
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / bh)
    const off = row % 2 ? bw / 2 : 0
    for (let x = 0; x < W; x++) {
      const xx = (x + off) % W
      const col = Math.floor(xx / bw)
      const inMortar = y % bh < mortar || xx % bw < mortar
      const tone = tones[(row * 7 + col) % 64]
      const grain = 0.85 + 0.15 * rnd()
      let r: number, g: number, b: number
      if (inMortar) { r = g = b = 0.22 * grain }
      else { r = 0.55 * tone * grain; g = 0.3 * tone * grain; b = 0.24 * tone * grain }
      d.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255], (y * W + x) * 4)
    }
  }
  brick = new DataTexture(d, W, H, RGBAFormat)
  brick.wrapS = brick.wrapT = RepeatWrapping
  brick.colorSpace = SRGBColorSpace
  brick.magFilter = LinearFilter
  brick.needsUpdate = true
  return brick
}

// ================================================================ v12: surface detail (all generated, no assets)
/** tileable value noise heightfield (size N, `grid` cells), deterministic */
function valueNoise(N: number, grid: number, seed0: number): Float32Array {
  let seed = seed0
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  const g: number[] = Array.from({ length: grid * grid }, rnd)
  const at = (x: number, y: number) => g[((y + grid) % grid) * grid + ((x + grid) % grid)]
  const out = new Float32Array(N * N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * grid, fy = (y / N) * grid
      const ix = Math.floor(fx), iy = Math.floor(fy)
      let tx = fx - ix, ty = fy - iy
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty)
      out[y * N + x] = (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty
    }
  return out
}
/** sum of octaves of tileable noise in 0..1 */
function fbm(N: number, octaves: [number, number][], seed: number): Float32Array {
  const out = new Float32Array(N * N)
  let wsum = 0
  octaves.forEach(([grid, w], k) => {
    const n = valueNoise(N, grid, seed + k * 7919)
    for (let i = 0; i < out.length; i++) out[i] += n[i] * w
    wsum += w
  })
  for (let i = 0; i < out.length; i++) out[i] /= wsum
  return out
}
function dataTex(d: Uint8Array, N: number, srgb = false): DataTexture {
  const t = new DataTexture(d, N, N, RGBAFormat)
  t.wrapS = t.wrapT = RepeatWrapping
  t.magFilter = LinearFilter
  t.generateMipmaps = true
  t.minFilter = LinearMipmapLinearFilter
  if (srgb) t.colorSpace = SRGBColorSpace
  t.needsUpdate = true
  return t
}
/** tangent-space normal map from a heightfield (wrapping) */
function normalFrom(h: Float32Array, N: number, strength: number): DataTexture {
  const d = new Uint8Array(N * N * 4)
  const H = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)]
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength
      const l = Math.hypot(dx, dy, 1)
      d.set([Math.round((-dx / l * 0.5 + 0.5) * 255), Math.round((-dy / l * 0.5 + 0.5) * 255), Math.round((1 / l * 0.5 + 0.5) * 255), 255], (y * N + x) * 4)
    }
  return dataTex(d, N)
}
const memo = new Map<string, DataTexture>()
const once = (k: string, f: () => DataTexture) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k)! }

/** concrete: pitted, slightly wavy surface */
export const concreteNormal = () => once('cN', () => {
  const N = 128
  const h = fbm(N, [[8, 1], [32, 0.5], [64, 0.35]], 4242)
  let s = 777; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  for (let i = 0; i < h.length; i++) if (rnd() < 0.012) h[i] -= 0.6 // pits
  return normalFrom(h, N, 2.2)
})
/** brick: same running bond as brickTexture (recessed mortar, bevelled brick edges, rough faces) */
export const brickNormal = () => once('bN', () => {
  const W = 256, bw = 64, bh = 24, mortar = 3
  const n = fbm(W, [[16, 1], [64, 0.6]], 99)
  const h = new Float32Array(W * W)
  for (let y = 0; y < W; y++) {
    const row = Math.floor(y / bh), off = row % 2 ? bw / 2 : 0
    for (let x = 0; x < W; x++) {
      const xx = (x + off) % W
      const ex = Math.min(xx % bw, bw - 1 - (xx % bw)), ey = Math.min(y % bh, bh - 1 - (y % bh))
      const e = Math.min(ex, ey) - mortar
      const face = e < 0 ? 0 : Math.min(1, 0.45 + e * 0.28)
      h[y * W + x] = face + (e < 0 ? 0.15 * n[y * W + x] : 0.25 * n[y * W + x])
    }
  }
  return normalFrom(h, W, 1.6)
})
/** floor roughness (G channel): blotchy wet-look patches 0.32..0.85 */
export const floorRoughness = () => once('fR', () => {
  const N = 128
  const h = fbm(N, [[4, 1], [12, 0.6], [48, 0.25]], 1717)
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < h.length; i++) {
    const wet = Math.min(1, Math.max(0, (h[i] - 0.48) * 4))
    const r = 0.85 - 0.53 * wet
    const v = Math.round(r * 255)
    d.set([v, v, v, 255], i * 4)
  }
  return dataTex(d, N)
})
/** road case laminate: scuffs + edge wear → roughness (G), and a fine pebble-grain normal */
export const caseRoughness = () => once('caseR', () => {
  const N = 128
  const n = fbm(N, [[8, 1], [32, 0.7], [96, 0.4]], 31337)
  let s = 4711; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < n.length; i++) d.set([0, Math.round(255 * (0.5 + 0.35 * n[i])), 0, 255], i * 4)
  // scratches: short bright (rough) diagonal strokes
  for (let k = 0; k < 70; k++) {
    let x = rnd() * N, y = rnd() * N
    const a = rnd() * Math.PI, len = 4 + rnd() * 26
    for (let j = 0; j < len; j++) {
      const i = ((Math.floor(y) + N) % N) * N + ((Math.floor(x) + N) % N)
      d[i * 4 + 1] = Math.min(255, d[i * 4 + 1] + 70)
      x += Math.cos(a); y += Math.sin(a)
    }
  }
  return dataTex(d, N)
})
export const caseNormal = () => once('caseN', () => normalFrom(fbm(128, [[64, 1], [128, 0.8]], 2024), 128, 1.2))
/** brushed metal (anisotropic look via stretched noise) → roughness map */
export const brushedRoughness = () => once('brush', () => {
  const N = 64
  let s = 99; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  const rows = Array.from({ length: N }, rnd)
  const d = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) d.set([0, Math.round(255 * (0.3 + 0.25 * rows[y] + 0.05 * rnd())), 0, 255], (y * N + x) * 4)
  return dataTex(d, N)
})
/** soft tileable noise for haze sheets / beam dust (R: large, G: fine) */
export const hazeNoise = () => once('haze', () => {
  const N = 128
  const a = fbm(N, [[4, 1], [8, 0.6], [16, 0.3]], 555), b = fbm(N, [[16, 1], [32, 0.5]], 666)
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < a.length; i++) d.set([Math.round(a[i] * 255), Math.round(b[i] * 255), 0, 255], i * 4)
  return dataTex(d, N)
})
