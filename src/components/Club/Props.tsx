import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { MeshBasicMaterial } from 'three'
import { beat } from '../../techno/beat'
import { PALETTE } from './index'

/** stream camera on a tripod facing the DJ; tiny red REC lamp (1 Hz blink, only while the music plays) */
export const TripodCamera: React.FC<{ position?: [number, number, number]; yaw?: number }> = ({ position = [0, 0, 0], yaw = 0 }) => {
  const rec = useRef<MeshBasicMaterial>(null)
  useFrame(() => {
    if (!rec.current) return
    const on = Math.floor(performance.now() / 500) % 2 === 0 ? 1 : 0.15
    rec.current.color.copy(PALETTE.red).multiplyScalar(beat.lit * on)
  })
  const legs = useMemo(() => [0, 1, 2].map((k) => (k / 3) * Math.PI * 2 + 0.3), [])
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      {legs.map((a) => (
        <mesh key={a} position={[Math.sin(a) * 0.22, 0.7, Math.cos(a) * 0.22]} rotation={[Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3]}>
          <cylinderGeometry args={[0.015, 0.015, 1.45, 6]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.7} roughness={0.5} />
        </mesh>
      ))}
      <group position={[0, 1.5, 0]}>
        <mesh>
          <boxGeometry args={[0.16, 0.18, 0.36]} />
          <meshStandardMaterial color="#121212" roughness={0.6} />
        </mesh>
        {/* lens (points to local -z) */}
        <mesh position={[0, 0, -0.24]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.06, 0.07, 0.14, 12]} />
          <meshStandardMaterial color="#0a0a0a" metalness={0.5} roughness={0.3} />
        </mesh>
        <mesh position={[0.05, 0.11, -0.12]}>
          <sphereGeometry args={[0.012, 8, 6]} />
          <meshBasicMaterial ref={rec} color="#000000" toneMapped={false} />
        </mesh>
      </group>
    </group>
  )
}

/** exposed ducts + pipes under a low ceiling (static, unlit until the show lights catch them) */
export const Ceiling: React.FC<{ width: number; zMin: number; zMax: number; height: number; map?: import('three').Texture }> = ({ width, zMin, zMax, height, map }) => {
  const depth = zMax - zMin
  const zc = (zMin + zMax) / 2
  return (
    <group>
      <mesh position={[0, height, zc]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={map} color="#555" roughness={0.95} />
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
