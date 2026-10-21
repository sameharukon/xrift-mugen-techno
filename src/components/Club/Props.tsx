import { useEffect, useMemo } from 'react'
import { CylinderGeometry } from 'three'
import { BRUSH_TILE, concreteNormal, PAINT_TILE } from './textures'
import { metalUV } from './geo'
import { brushedMetal, paintedSteel } from './metal'
import { envOn } from './fx'

/** exposed ducts + pipes under a low ceiling (static, unlit until the show lights catch them) */
export const Ceiling: React.FC<{ width: number; zMin: number; zMax: number; height: number; map?: import('three').Texture }> = ({ width, zMin, zMax, height, map }) => {
  const nrm = useMemo(() => { const t = concreteNormal().clone(); t.repeat.set(3, 3); t.needsUpdate = true; return t }, [])
  const depth = zMax - zMin
  const zc = (zMin + zMax) / 2
  // v16: galvanised ducts (brushed set) + painted pipes (painted set), baked in place so the metre-based UVs line up
  const geo = useMemo(() => {
    const ducts = [-width * 0.3, width * 0.3].map((x) => metalUV(new CylinderGeometry(0.24, 0.24, depth, 14, 1, true).rotateX(Math.PI / 2).translate(x, height - 0.32, zc), BRUSH_TILE, true))
    const pipes = [zMin + 1.2, zMin + 3.4, zc + 1.6].map((z, i) => metalUV(new CylinderGeometry(0.04, 0.04, width, 8).rotateZ(Math.PI / 2).translate(0, height - 0.12 - i * 0.05, z), PAINT_TILE, false))
    return { ducts, pipes }
  }, [width, depth, height, zc, zMin])
  const mats = useMemo(() => ({ duct: brushedMetal('#5a5d60', 0.8, 0.2), pipe: paintedSteel('#6a655f', 0.3) }), [])
  useEffect(() => { envOn(mats.duct, 0.35, false, true); envOn(mats.pipe, 0.3, false, true) }, [mats])
  return (
    <group>
      <mesh position={[0, height, zc]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={map} normalMap={nrm} normalScale={[0.5, 0.5]} color="#555" roughness={0.92} />
      </mesh>
      {/* two big round ducts running front → back */}
      {geo.ducts.map((g, i) => <mesh key={i} geometry={g} material={mats.duct} />)}
      {/* thin pipes across */}
      {geo.pipes.map((g, i) => <mesh key={i} geometry={g} material={mats.pipe} />)}
    </group>
  )
}
