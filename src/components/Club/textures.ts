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
  // v16: per-axis cell indices + smoothstep weights precomputed once (same maths / results, ~5× faster)
  const i0 = new Int32Array(N), i1 = new Int32Array(N), w = new Float64Array(N)
  for (let x = 0; x < N; x++) {
    const fx = (x / N) * grid, ix = Math.floor(fx)
    let tx = fx - ix
    tx = tx * tx * (3 - 2 * tx)
    i0[x] = (ix + grid) % grid; i1[x] = (ix + 1 + grid) % grid; w[x] = tx
  }
  const out = new Float32Array(N * N)
  for (let y = 0; y < N; y++) {
    const r0 = i0[y] * grid, r1 = i1[y] * grid, ty = w[y]
    for (let x = 0; x < N; x++) {
      const a = i0[x], b = i1[x], tx = w[x]
      out[y * N + x] = (g[r0 + a] * (1 - tx) + g[r0 + b] * tx) * (1 - ty) + (g[r1 + a] * (1 - tx) + g[r1 + b] * tx) * ty
    }
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
/** soft tileable noise for haze sheets / dust (R: large, G: fine) */
export const hazeNoise = () => once('haze', () => {
  const N = 128
  const a = fbm(N, [[4, 1], [8, 0.6], [16, 0.3]], 555), b = fbm(N, [[16, 1], [32, 0.5]], 666)
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < a.length; i++) d.set([Math.round(a[i] * 255), Math.round(b[i] * 255), 0, 255], i * 4)
  return dataTex(d, N)
})

// ================================================================ v16: metals (metre-based UVs, see geo.ts metalUV)
/** brushed-metal texture tile size (m): 512 px → ~1.6 mm / px */
export const BRUSH_TILE = 0.8
/** painted-steel texture tile size (m): one tile spans door height (V = world height, grime towards the floor) */
export const PAINT_TILE = 2.4

/** linear 0..1 → sRGB byte (LUT; the per-pixel Math.pow was the slowest part of generation) */
const SRGB_LUT = (() => { const t = new Uint8Array(4097); for (let i = 0; i <= 4096; i++) t[i] = Math.round(255 * Math.pow(i / 4096, 1 / 2.2)); return t })()
const srgb8 = (v: number) => SRGB_LUT[Math.round(Math.min(1, Math.max(0, v)) * 4096)]
/** like normalFrom (sqrt instead of hypot, preallocated writes) — used by the v16 maps only, so older maps stay bit-identical */
function normalFast(h: Float32Array, N: number, strength: number): DataTexture {
  const d = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    const ym = ((y - 1 + N) % N) * N, yp = ((y + 1) % N) * N, yc = y * N
    for (let x = 0; x < N; x++) {
      const xm = (x - 1 + N) % N, xp = (x + 1) % N
      const dx = (h[yc + xp] - h[yc + xm]) * strength, dy = (h[yp + x] - h[ym + x]) * strength
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1), o = (yc + x) * 4
      d[o] = Math.round((-dx * il * 0.5 + 0.5) * 255); d[o + 1] = Math.round((-dy * il * 0.5 + 0.5) * 255); d[o + 2] = Math.round((il * 0.5 + 0.5) * 255); d[o + 3] = 255
    }
  }
  return dataTex(d, N)
}
const lcg = (seed: number) => { let s = seed; return () => ((s = (Math.imul(s, 1103515245) + 12345) | 0) >>> 0) / 4294967296 }
/** tileable anisotropic value noise: gx cells across, gy cells down (gy ≫ gx → long horizontal streaks) */
function anisoNoise(N: number, gx: number, gy: number, seed: number): Float32Array {
  const rnd = lcg(seed)
  const g = new Float32Array(gx * gy).map(rnd)
  const out = new Float32Array(N * N)
  for (let y = 0; y < N; y++) {
    const fy = (y / N) * gy, iy = Math.floor(fy); let ty = fy - iy; ty = ty * ty * (3 - 2 * ty)
    const r0 = (iy % gy) * gx, r1 = ((iy + 1) % gy) * gx
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * gx, ix = Math.floor(fx); let tx = fx - ix; tx = tx * tx * (3 - 2 * tx)
      const x0 = ix % gx, x1 = (ix + 1) % gx
      out[y * N + x] = (g[r0 + x0] * (1 - tx) + g[r0 + x1] * tx) * (1 - ty) + (g[r1 + x0] * (1 - tx) + g[r1 + x1] * tx) * ty
    }
  }
  return out
}
/** antialiased soft stroke (wrapping): writes max(f, val · coverage) */
function stroke(f: Float32Array, N: number, x0: number, y0: number, ang: number, len: number, w: number, val: number) {
  const dx = Math.cos(ang), dy = Math.sin(ang)
  const r = Math.ceil(w + 1)
  for (let j = 0; j <= len; j += 1) {
    const t = j / len, taper = Math.min(1, t * 6, (1 - t) * 6) // thin out at both ends
    const cx = x0 + dx * j, cy = y0 + dy * j
    for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
      const px = Math.floor(cx) + ox, py = Math.floor(cy) + oy
      const d = Math.abs((px + 0.5 - cx) * -dy + (py + 0.5 - cy) * dx) // distance across the stroke
      const c = Math.max(0, 1 - d / w) * taper * val
      if (c <= 0) continue
      const i = ((py % N + N) % N) * N + ((px % N + N) % N)
      if (c > f[i]) f[i] = c
    }
  }
}

/** brushed steel / aluminium: shared fields (brushing grain, smudges + fingerprints, fine scratches, grime) */
const brushFields = (() => {
  let cache: { N: number; grain: Float32Array; smudge: Float32Array; scratch: Float32Array; grime: Float32Array } | null = null
  return () => {
    if (cache) return cache
    const N = 512
    // grain: long streaks of varying length (few cells across, hundreds down), plus per-row hairlines
    const a = anisoNoise(N, 3, 170, 7101), b = anisoNoise(N, 7, 340, 7102), c = anisoNoise(N, 2, 512, 7103)
    const grain = new Float32Array(N * N)
    for (let i = 0; i < grain.length; i++) grain[i] = 0.4 * a[i] + 0.35 * b[i] + 0.25 * c[i]
    // smudges: soft wiped patches + elliptical fingerprints (whorl rings), greasy = smoother and slightly darker
    const wipe = fbm(N, [[3, 1], [6, 0.6], [12, 0.3]], 7104)
    const smudge = new Float32Array(N * N)
    for (let i = 0; i < N * N; i++) smudge[i] = Math.min(1, Math.max(0, (wipe[i] - 0.52) * 3))
    const rnd = lcg(7105)
    for (let k = 0; k < 14; k++) {
      const cx = rnd() * N, cy = rnd() * N, rx = 9 + rnd() * 9, ry = rx * (1.25 + 0.3 * rnd()), rot = rnd() * Math.PI, str = 0.35 + 0.4 * rnd()
      const R = Math.ceil(ry + 2), cr = Math.cos(rot), sr = Math.sin(rot)
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
        const u = (ox * cr + oy * sr) / rx, v = (-ox * sr + oy * cr) / ry, d = Math.hypot(u, v)
        if (d >= 1) continue
        const ridge = 0.5 + 0.5 * Math.cos(d * 26 + u * 3) // whorl ridges
        const val = str * (1 - d * d) * (0.55 + 0.45 * ridge)
        const i = (((Math.floor(cy) + oy) % N + N) % N) * N + (((Math.floor(cx) + ox) % N + N) % N)
        smudge[i] = Math.max(smudge[i], val)
      }
    }
    // fine scratches: mostly along the grain (±8°), a few random, low contrast, soft edges
    const scratch = new Float32Array(N * N)
    for (let k = 0; k < 70; k++) {
      const along = rnd() < 0.75
      const ang = along ? (rnd() - 0.5) * 0.28 + (rnd() < 0.5 ? 0 : Math.PI) : rnd() * Math.PI * 2
      stroke(scratch, N, rnd() * N, rnd() * N, ang, 10 + rnd() * (along ? 90 : 35), 0.7 + rnd() * 0.6, 0.25 + 0.5 * rnd())
    }
    const grime = fbm(N, [[2, 1], [5, 0.7], [20, 0.25]], 7106)
    cache = { N, grain, smudge, scratch, grime }
    return cache
  }
})()
/** brushed metal albedo multiplier (sRGB, near white): greasy smudges and grime slightly darker, scratches brighter */
export const brushedColor = () => once('brC', () => {
  const { N, grain, smudge, scratch, grime } = brushFields()
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < N * N; i++) {
    const v = Math.min(1, 0.9 + 0.06 * (grain[i] - 0.5) - 0.1 * smudge[i] - 0.14 * Math.max(0, grime[i] - 0.45) + 0.08 * scratch[i])
    const c8 = srgb8(v), o = i * 4
    d[o] = d[o + 1] = d[o + 2] = c8; d[o + 3] = 255
  }
  return dataTex(d, N, true)
})
/** brushed metal roughness (G): 0.34 ± grain, smudges / grime rougher-or-greasy, scratches cut through */
export const brushedRM = () => once('brRM', () => {
  const { N, grain, smudge, scratch, grime } = brushFields()
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < N * N; i++) {
    const r = 0.36 + 0.12 * (grain[i] - 0.5) + 0.14 * smudge[i] + 0.12 * Math.max(0, grime[i] - 0.5) - 0.1 * scratch[i]
    d.set([0, Math.round(255 * Math.min(0.85, Math.max(0.2, r))), 0, 255], i * 4)
  }
  return dataTex(d, N)
})
/** brushing grooves (across the grain only) + scratch grooves: subtle, use normalScale ≈ 0.3 */
export const brushedNormal = () => once('brN', () => {
  const { N, grain, scratch } = brushFields()
  const h = new Float32Array(N * N)
  for (let i = 0; i < h.length; i++) h[i] = grain[i] * 0.6 - scratch[i] * 0.5
  return normalFast(h, N, 1.6)
})

// ================================================================ weathered industrial steel (entrance door / frame / fittings)
// v16: 512 px over PAINT_TILE (2.4 m, V = height), dielectric paint (metalness 0) with bare-steel scratches,
// antialiased low-contrast scratches concentrated where hands / feet / carts hit, greasy hand smudges at handle height
const steelFields = (() => {
  let cache: { N: number; rust: Float32Array; grime: Float32Array; dents: Float32Array; scratch: Float32Array; streak: Float32Array; hand: Float32Array; tone: Float32Array } | null = null
  return () => {
    if (cache) return cache
    const N = 512
    const rustN = fbm(N, [[6, 1], [16, 0.7], [64, 0.45]], 9001)
    const grime = fbm(N, [[4, 1], [24, 0.5]], 9002)
    const dents = fbm(N, [[5, 1], [12, 0.5]], 9003)
    const handN = fbm(N, [[8, 1], [24, 0.5]], 9005)
    const toneN = fbm(N, [[3, 1], [9, 0.6], [40, 0.2]], 9007)
    const rust = new Float32Array(N * N)
    const scratch = new Float32Array(N * N)
    const streak = new Float32Array(N * N)
    const hand = new Float32Array(N * N)
    for (let i = 0; i < rust.length; i++) {
      const y = Math.floor(i / N) / N // 0 = floor … 1 = 2.4 m
      rust[i] = Math.min(1, Math.max(0, (rustN[i] - 0.6 + 0.16 * Math.max(0, 1 - y * 5)) * 3.2)) * 0.75
      // greasy hand zone ≈ 0.85 … 1.35 m
      const band = Math.exp(-(((y - 0.46) / 0.09) ** 2))
      hand[i] = Math.min(1, Math.max(0, (handN[i] - 0.45) * 2.5)) * band
    }
    const rnd = lcg(31)
    // faint rust run-off below a few rust spots (soft, 2–4 px wide)
    for (let k = 0; k < 22; k++) {
      const x0 = rnd() * N, y0 = N * (0.25 + 0.6 * rnd()), len = N * (0.04 + 0.16 * rnd())
      stroke(streak, N, x0, y0, -Math.PI / 2 + (rnd() - 0.5) * 0.05, len, 1.5 + rnd() * 2, 0.35 + 0.3 * rnd())
    }
    // scuffs in clusters (a boot / cart / ring hits several parallel fine lines at once), mostly in the kick zone and
    // at handle height; lengths, angles, spacing and depth all vary; plus a few isolated nicks
    for (let k = 0; k < 46; k++) {
      const zone = rnd()
      const y = zone < 0.45 ? rnd() * 0.16 : zone < 0.8 ? 0.36 + rnd() * 0.2 : rnd()
      const x = rnd() * N, base = (rnd() - 0.5) * (rnd() < 0.7 ? 0.5 : 2.5)
      const lines = 1 + Math.floor(rnd() * rnd() * 7), len0 = 5 + rnd() * rnd() * 45, depth = 0.15 + 0.45 * rnd()
      for (let l = 0; l < lines; l++) {
        const off = (l - lines / 2) * (1.2 + rnd() * 2.2)
        const a = base + (rnd() - 0.5) * 0.06
        stroke(scratch, N, x - Math.sin(a) * off + (rnd() - 0.5) * 6, y * N + Math.cos(a) * off, a, len0 * (0.4 + 0.6 * rnd()), 0.5 + rnd() * 0.5, depth * (0.4 + 0.6 * rnd()))
      }
    }
    for (let k = 0; k < 40; k++) stroke(scratch, N, rnd() * N, rnd() * N, rnd() * Math.PI * 2, 1.5 + rnd() * 4, 0.6 + rnd() * 0.5, 0.15 + 0.35 * rnd())
    const tone = toneN
    cache = { N, rust, grime, dents, scratch, streak, hand, tone }
    return cache
  }
})()
/** sRGB albedo: dark blue-grey paint (albedo already accounts for metalness 0), rust, scratches = bare steel */
export const steelColor = () => once('stC', () => {
  const { N, rust, grime, scratch, streak, hand, tone } = steelFields()
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < rust.length; i++) {
    const y = Math.floor(i / N) / N
    const g = (0.86 + 0.24 * (tone[i] - 0.5)) * (0.78 + 0.3 * grime[i] - 0.35 * Math.max(0, 0.12 - y) / 0.12 * (0.5 + grime[i])) * (1 - 0.12 * hand[i])
    let r = 0.16 * g, gg = 0.167 * g, b = 0.182 * g
    const ru = Math.max(rust[i], streak[i] * 0.6)
    r = r * (1 - ru) + 0.13 * ru; gg = gg * (1 - ru) + 0.075 * ru; b = b * (1 - ru) + 0.05 * ru
    const s = scratch[i]
    r = r * (1 - s) + 0.36 * s; gg = gg * (1 - s) + 0.36 * s; b = b * (1 - s) + 0.37 * s
    const o = i * 4
    d[o] = srgb8(r); d[o + 1] = srgb8(gg); d[o + 2] = srgb8(b); d[o + 3] = 255
  }
  return dataTex(d, N, true)
})
/** G = roughness (paint satin 0.55–0.75, greasy hands smoother, rust rough), B = metalness (paint/rust 0, bare scratches 0.9) */
export const steelRM = () => once('stRM', () => {
  const { N, rust, grime, scratch, streak, hand } = steelFields()
  const d = new Uint8Array(N * N * 4)
  for (let i = 0; i < rust.length; i++) {
    const ru = Math.max(rust[i], streak[i] * 0.5), s = scratch[i]
    let rough = 0.44 + 0.2 * grime[i] - 0.14 * hand[i]
    rough = rough * (1 - ru) + 0.9 * ru
    rough = rough * (1 - s) + 0.34 * s
    const metal = 0.9 * s * (1 - ru)
    d.set([0, Math.round(255 * Math.min(1, rough)), Math.round(255 * Math.max(0, metal)), 255], i * 4)
  }
  return dataTex(d, N)
})
/** soft dents, faint orange-peel paint, pitted rust (restrained: normalScale ≈ 0.5) */
export const steelNormal = () => once('stN', () => {
  const { N, rust, dents, scratch } = steelFields()
  const fine = fbm(N, [[96, 1], [192, 0.7]], 9004)
  const peel = fbm(N, [[128, 1]], 9006)
  const h = new Float32Array(N * N)
  for (let i = 0; i < h.length; i++) h[i] = dents[i] * 0.9 + rust[i] * (fine[i] - 0.5) * 0.5 + rust[i] * 0.08 + peel[i] * 0.03 - scratch[i] * 0.04
  return normalFast(h, N, 2.0)
})

// ================================================================ v19: grime atlas (multiply decals)
/**
 * 2 × 2 atlas, white = no change, darker = darkens what's behind (MultiplyBlending):
 * [0] damp patch rising from the floor (ragged tide line, mottled), [1] run-off streaks from above (soot / rust drips),
 * [2] floor stain (spill / oil, dried edge ring), [3] patchy grime / soot. Cell borders fade to white.
 */
export const grimeAtlas = () => once('grime', () => {
  const N = 512, C = 256
  const d = new Uint8Array(N * N * 4)
  const nA = fbm(C, [[4, 1], [8, 0.6], [32, 0.35], [64, 0.2]], 9001), nB = fbm(C, [[8, 1], [24, 0.5], [96, 0.3]], 9002)
  const n1 = (u: number, s: number) => { const x = u * 6 + s; const i = Math.floor(x), f = x - i; const a = Math.sin(i * 127.1 + s * 311.7) * 43758.5453, b = Math.sin((i + 1) * 127.1 + s * 311.7) * 43758.5453; return (a - Math.floor(a)) * (1 - f * f * (3 - 2 * f)) + (b - Math.floor(b)) * f * f * (3 - 2 * f) }
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
  let s = 31; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) | 0) >>> 0) / 4294967296
  const streaks = Array.from({ length: 14 }, () => ({ x: 0.08 + rnd() * 0.84, w: 0.006 + rnd() * 0.02, len: 0.25 + rnd() * 0.7, k: 0.25 + rnd() * 0.45 }))
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
    const cell = cy * 2 + cx
    for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
      const u = (x + 0.5) / C, v = (y + 0.5) / C, i = y * C + x
      const a = nA[i], b = nB[i]
      let dark = 0
      if (cell === 0) {
        const top = 0.5 + 0.28 * n1(u, 1) + 0.1 * (b - 0.5)
        const body = sm(top, top - 0.3, v) * (0.55 + 0.45 * a)
        const tide = Math.exp(-(((v - top) / 0.025) ** 2)) * 0.3
        dark = (0.5 * body + tide) * sm(0, 0.18, u) * sm(1, 0.82, u)
      } else if (cell === 1) {
        for (const st of streaks) {
          const dx = Math.abs(u - st.x - 0.01 * Math.sin(v * 9 + st.x * 20)) / st.w
          if (dx < 1) dark += (1 - dx * dx) * st.k * sm(1 - st.len, 1 - st.len * 0.5, v) * (0.6 + 0.4 * a)
        }
        dark += 0.35 * sm(0.8, 1, v) * a
        dark *= sm(0, 0.1, u) * sm(1, 0.9, u)
      } else if (cell === 2) {
        const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx)
        const edge = 0.3 + 0.035 * Math.sin(ang * 2 + 1.3) + 0.02 * Math.sin(ang * 5 + 0.4) + 0.16 * (a - 0.5)
        dark = sm(edge, edge - 0.22, r) * (0.22 + 0.3 * b) + Math.exp(-(((r - edge) / 0.015) ** 2)) * 0.1 * b
      } else {
        const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy)
        dark = sm(0.5, 0.2, r) * sm(0.42, 0.75, a * 0.7 + b * 0.3) * 0.55
      }
      const val = Math.max(0.3, 1 - Math.min(0.7, dark * 1.25))
      const c8 = Math.round(255 * val)
      d.set([c8, c8, c8, 255], ((cy * C + y) * N + cx * C + x) * 4)
    }
  }
  const t = dataTex(d, N)
  t.wrapS = t.wrapT = 1001 // ClampToEdgeWrapping
  t.colorSpace = 'srgb'
  return t
})
