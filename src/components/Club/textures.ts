import { DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace } from 'three'

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
