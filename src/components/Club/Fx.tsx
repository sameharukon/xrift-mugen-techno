import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending, DataTexture, EquirectangularReflectionMapping, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial,
  PlaneGeometry, PMREMGenerator, RGBAFormat, SRGBColorSpace, ShaderMaterial, Vector4, type WebGLProgramParametersWithUniforms,
} from 'three'
import { beat } from '../../techno/beat'
import { PALETTE, useConcrete } from '.'
import { envOn, envReg, fx, halo, HALO_CAP, MAX_BEAMS, shaderClock } from './fx'
import { concreteNormal, floorRoughness, hazeNoise } from './textures'

// ================================================================ dark environment map
/**
 * Tiny generated equirect (128×64): black floor hemisphere, near-black ceiling, a faint band of cold / warm
 * "tube" stripes slightly above the horizon and a deep-red glow patch → PMREM. Opted-in metals / screens /
 * the wet floor reflect it; its intensity follows the lights (dark when the club is dark).
 */
export const ClubEnv: React.FC = () => {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const W = 128, H = 64
    const d = new Uint8Array(W * H * 4)
    for (let y = 0; y < H; y++) {
      const el = (0.5 - (y + 0.5) / H) * Math.PI // +π/2 up … −π/2 down
      for (let x = 0; x < W; x++) {
        const az = (x / W) * Math.PI * 2
        let r = 0, g = 0, b = 0
        if (el > 0) { r = g = b = 0.018 + 0.01 * Math.sin(el) }
        // tube band 8°..28° elevation, 9 stripes around
        const band = Math.exp(-(((el - 0.3) / 0.12) ** 2))
        const stripes = Math.pow(Math.max(0, Math.cos(az * 9)), 18)
        const warm = Math.sin(az * 3) > 0.4
        r += band * stripes * (warm ? 0.55 : 0.42); g += band * stripes * (warm ? 0.5 : 0.46); b += band * stripes * (warm ? 0.42 : 0.55)
        // soft wide white wash from the truss side + red glow patch
        const wash = Math.exp(-(((el - 0.45) / 0.35) ** 2)) * Math.exp(-(((az - Math.PI) / 0.9) ** 2))
        r += wash * 0.08; g += wash * 0.085; b += wash * 0.1
        const red = Math.exp(-(((el - 0.15) / 0.25) ** 2)) * Math.exp(-(((az - 0.6) / 0.5) ** 2))
        r += red * 0.35; g += red * 0.02; b += red * 0.03
        d.set([r, g, b].map((v) => Math.round(255 * Math.min(1, Math.pow(v, 1 / 2.2)))).concat(255), (y * W + x) * 4)
      }
    }
    const eq = new DataTexture(d, W, H, RGBAFormat)
    eq.mapping = EquirectangularReflectionMapping
    eq.colorSpace = SRGBColorSpace
    eq.needsUpdate = true
    const pm = new PMREMGenerator(gl)
    const rt = pm.fromEquirectangular(eq)
    eq.dispose()
    pm.dispose()
    envReg.tex = rt.texture
    for (const { m, base, always } of envReg.mats) { m.envMap = rt.texture; m.envMapIntensity = always ? base : 0; m.needsUpdate = true }
    return () => { envReg.tex = null; rt.dispose() }
  }, [gl])
  useFrame(() => {
    const f = beat.lit * (1 - beat.preDrop) * Math.min(1.6, 0.45 + 0.55 * beat.whiteEnv + 0.3 * fx.rigGlow + 0.2 * fx.wallGlow)
    for (const { m, base, always } of envReg.mats) if (!always) m.envMapIntensity = base * f
  })
  return null
}

// ================================================================ fake bloom: one instanced draw for every halo
const HALO_VERT = /* glsl */ `
attribute vec4 aC;
attribute vec4 aA;
attribute vec3 aCol;
varying vec2 vQ;
varying float vL;
varying float vR;
varying vec3 vCol;
varying float vI;
void main() {
  vec3 c = aC.xyz;
  float R = aC.w;
  float L = length(aA.xyz);
  vec3 toCam = normalize(cameraPosition - c);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 u = camU, v = camR;
  if (L > 1e-4) {
    u = aA.xyz / L;
    vec3 w = cross(u, toCam);
    v = length(w) > 1e-3 ? normalize(w) : camR;
  }
  vec3 p = c + u * position.y * (L + R) + v * position.x * R + toCam * 0.03;
  vQ = vec2(position.x * R, position.y * (L + R));
  vL = L;
  vR = R;
  vCol = aCol;
  vI = aA.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (vI < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off: degenerate, outside clip
}`
const HALO_FRAG = /* glsl */ `
varying vec2 vQ;
varying float vL;
varying float vR;
varying vec3 vCol;
varying float vI;
void main() {
  float d = length(vec2(vQ.x, max(0.0, abs(vQ.y) - vL))) / vR;
  float g = exp(-d * d * 5.0) * 0.55 + exp(-d * 3.2) * 0.45;
  g *= 1.0 - smoothstep(0.7, 1.0, d);
  gl_FragColor = vec4(vCol * g * vI, 1.0);
}`
export const HaloField: React.FC = () => {
  const mesh = useRef<InstancedMesh>(null)
  const { geo, mat, attrs } = useMemo(() => {
    const geo = new PlaneGeometry(2, 2)
    const attrs = {
      c: new InstancedBufferAttribute(halo.c, 4),
      a: new InstancedBufferAttribute(halo.a, 4),
      col: new InstancedBufferAttribute(halo.col, 3),
    }
    geo.setAttribute('aC', attrs.c)
    geo.setAttribute('aA', attrs.a)
    geo.setAttribute('aCol', attrs.col)
    const mat = new ShaderMaterial({ vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })
    return { geo, mat, attrs }
  }, [])
  useFrame(() => {
    const m = mesh.current
    if (!m) return
    m.count = Math.min(HALO_CAP, halo.n)
    attrs.c.needsUpdate = attrs.a.needsUpdate = attrs.col.needsUpdate = true
  })
  return <instancedMesh ref={mesh} args={[geo, mat, HALO_CAP]} frustumCulled={false} renderOrder={6} />
}

// ================================================================ haze: two head-height sheets that catch the beams
const HAZE_VERT = /* glsl */ `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`
const HAZE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform float uLit;
uniform float uBase;
uniform float uWall;
uniform float uWallZ;
uniform float uBeamRad;
uniform float uSeed;
uniform vec3 uCol;
uniform vec4 uBP[${MAX_BEAMS}];
uniform vec4 uBD[${MAX_BEAMS}];
varying vec3 vW;
void main() {
  vec2 q = vW.xz + uSeed;
  float n = texture2D(uNoise, q * 0.11 + vec2(uTime * 0.008, uTime * 0.005)).r * 0.6
          + texture2D(uNoise, q * 0.29 - vec2(uTime * 0.015, -uTime * 0.01)).g * 0.4;
  float dens = smoothstep(0.3, 0.85, n);
  float b = 0.0;
  for (int i = 0; i < ${MAX_BEAMS}; i++) {
    vec3 p = uBP[i].xyz;
    vec3 d = uBD[i].xyz;
    float len = uBD[i].w;
    float t = clamp(dot(vW - p, d), 0.0, len);
    float r = 0.05 + uBeamRad * t / len;
    vec3 off = vW - (p + d * t);
    b += uBP[i].w * exp(-dot(off, off) / (r * r) * 1.4) * (1.0 - 0.5 * t / len);
  }
  float wall = uWall * exp(-max(0.0, vW.z - uWallZ) * 0.9);
  float a = dens * (uBase + 0.9 * b + 0.12 * wall) + 0.3 * b * (0.4 + 0.6 * dens);
  float dist = length(cameraPosition - vW);
  a *= (1.0 - smoothstep(6.0, 15.0, dist)) * smoothstep(0.25, 1.4, dist);
  gl_FragColor = vec4(uCol * a * uLit, 1.0);
}`
export interface HazeProps { width: number; zMin: number; zMax: number; heights?: number[]; wallZ: number }
export const HazeLayers: React.FC<HazeProps> = ({ width, zMin, zMax, heights = [1.95, 2.4], wallZ }) => {
  const mats = useMemo(() => heights.map((_, k) => new ShaderMaterial({
    vertexShader: HAZE_VERT, fragmentShader: HAZE_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    uniforms: {
      uNoise: { value: hazeNoise() }, uTime: { value: 0 }, uLit: { value: 0 }, uBase: { value: 0.02 }, uWall: { value: 0 }, uWallZ: { value: wallZ },
      uBeamRad: { value: 0.2 }, uSeed: { value: k * 3.7 }, uCol: { value: PALETTE.cold.clone().multiplyScalar(0.5) },
      uBP: { value: Array.from({ length: MAX_BEAMS }, () => new Vector4()) }, uBD: { value: Array.from({ length: MAX_BEAMS }, () => new Vector4(0, -1, 0, 1)) },
    },
  })), [heights, wallZ])
  useFrame(() => {
    const t = shaderClock().t // wrapped (float32-safe; seamless: tiling noise texture)
    const lit = beat.lit * (1 - beat.preDrop)
    for (const m of mats) {
      const U = m.uniforms
      U.uTime.value = t
      U.uLit.value = lit
      U.uBase.value = 0.012 + 0.02 * beat.whiteEnv + 0.012 * beat.breakAmt
      U.uWall.value = fx.wallGlow
      fx.beams.forEach((B, i) => {
        U.uBP.value[i].set(B.p.x, B.p.y, B.p.z, B.v)
        U.uBD.value[i].set(B.d.x, B.d.y, B.d.z, B.len)
      })
      U.uBeamRad.value = fx.beams[0].rad
    }
  })
  const depth = zMax - zMin
  return (
    <group>
      {heights.map((y, k) => (
        <mesh key={k} position={[0, y, (zMin + zMax) / 2]} rotation={[-Math.PI / 2, 0, 0]} material={mats[k]} renderOrder={4}>
          <planeGeometry args={[width, depth]} />
        </mesh>
      ))}
    </group>
  )
}

// ================================================================ wet-look concrete floor (stays dark; beam hits glint)
export const ClubFloor: React.FC<{ width: number; depth: number; zc: number; color: string; repeat?: number; env?: number; always?: boolean }> = ({ width, depth, zc, color, repeat = 5, env = 0.5, always = false }) => {
  const map = useConcrete(repeat)
  const mat = useMemo(() => {
    const rough = floorRoughness().clone(); rough.repeat.set(2.2 * repeat / 5, 2.6 * repeat / 5); rough.needsUpdate = true
    const nrm = concreteNormal().clone(); nrm.repeat.set(repeat, repeat); nrm.needsUpdate = true
    const m = new MeshStandardMaterial({ map, color, roughness: 1, roughnessMap: rough, normalMap: nrm, metalness: 0 })
    m.normalScale.set(0.6, 0.6)
    const hits = Array.from({ length: MAX_BEAMS }, () => new Vector4(0, 0, 1, 0))
    m.userData.hits = hits
    m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
      sh.uniforms.uHits = { value: hits }
      sh.uniforms.uHitCol = { value: PALETTE.cold }
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFloorW;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvFloorW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vFloorW;\nuniform vec4 uHits[${MAX_BEAMS}];\nuniform vec3 uHitCol;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float h = 0.0;
    for (int i = 0; i < ${MAX_BEAMS}; i++) { vec2 o = vFloorW.xz - uHits[i].xy; h += uHits[i].w * exp(-dot(o, o) / (uHits[i].z * uHits[i].z)); }
    totalEmissiveRadiance += uHitCol * h * (0.25 + 0.75 * (1.0 - roughnessFactor));
  }`)
    }
    return m
  }, [map, color, repeat])
  useEffect(() => { envOn(mat, env, always) }, [mat, env, always])
  useFrame(() => {
    const hits = mat.userData.hits as Vector4[]
    fx.beams.forEach((B, i) => {
      const h = hits[i]
      if (B.v < 0.003 || B.d.y > -0.05) { h.w = 0; return }
      const t = -B.p.y / B.d.y
      const reach = Math.max(0, 1 - Math.max(0, t - B.len) / 0.8)
      h.set(B.p.x + B.d.x * t, B.p.z + B.d.z * t, 0.12 + B.rad * Math.min(t, B.len) / B.len, B.v * 0.09 * reach)
    })
  })
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, zc]} material={mat}>
      <planeGeometry args={[width, depth]} />
    </mesh>
  )
}
