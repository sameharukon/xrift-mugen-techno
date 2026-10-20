import { useMemo } from 'react'
import { concreteNormal } from './textures'

/** exposed ducts + pipes under a low ceiling (static, unlit until the show lights catch them) */
export const Ceiling: React.FC<{ width: number; zMin: number; zMax: number; height: number; map?: import('three').Texture }> = ({ width, zMin, zMax, height, map }) => {
  const nrm = useMemo(() => { const t = concreteNormal().clone(); t.repeat.set(3, 3); t.needsUpdate = true; return t }, [])
  const depth = zMax - zMin
  const zc = (zMin + zMax) / 2
  return (
    <group>
      <mesh position={[0, height, zc]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={map} normalMap={nrm} normalScale={[0.5, 0.5]} color="#555" roughness={0.92} />
      </mesh>
      {/* two big round ducts running front → back */}
      {[-width * 0.3, width * 0.3].map((x) => (
        <mesh key={x} position={[x, height - 0.32, zc]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.24, 0.24, depth, 14, 1, true]} />
          <meshStandardMaterial color="#5a5d60" metalness={0.8} roughness={0.45} />
        </mesh>
      ))}
      {/* thin pipes across */}
      {[zMin + 1.2, zMin + 3.4, zc + 1.6].map((z, i) => (
        <mesh key={z} position={[0, height - 0.12 - i * 0.05, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.04, 0.04, width, 8]} />
          <meshStandardMaterial color="#3e3a36" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
    </group>
  )
}
