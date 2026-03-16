import * as THREE from 'three'

const POOL_SIZE = 64
const PARTICLES_PER_SPAWN = 6
const LIFETIME = 0.3
const SIZE = 0.25
const OPACITY = 0.25

type Particle = {
  mesh: THREE.Points
  velocity: THREE.Vector3
  life: number
  maxLife: number
}

export function createCollisionParticles(scene: THREE.Scene): {
  spawn: (position: { x: number; y: number; z: number }) => void
  update: (dt: number) => void
} {
  const pool: Particle[] = []
  const active: Particle[] = []

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: OPACITY,
    size: SIZE,
    sizeAttenuation: true,
    depthWrite: false
  })

  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Points(geo.clone(), mat.clone())
    mesh.visible = false
    scene.add(mesh)
    pool.push({
      mesh,
      velocity: new THREE.Vector3(),
      life: 0,
      maxLife: 0
    })
  }

  function spawn(position: { x: number; y: number; z: number }) {
    const count = Math.min(PARTICLES_PER_SPAWN, pool.length)
    for (let i = 0; i < count; i++) {
      const p = pool.pop()
      if (!p) break
      p.mesh.position.set(position.x, position.y, position.z)
      p.mesh.visible = true
      const theta = (i / count) * Math.PI * 2 + Math.random() * 0.5
      const phi = Math.random() * Math.PI * 0.5
      const speed = 0.5 + Math.random() * 1
      p.velocity.set(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed,
        Math.sin(phi) * Math.sin(theta) * speed
      )
      p.life = 0
      p.maxLife = LIFETIME * (0.7 + Math.random() * 0.6)
      active.push(p)
    }
  }

  function update(dt: number) {
    for (let i = active.length - 1; i >= 0; i--) {
      const p = active[i]
      p.life += dt
      p.mesh.position.addScaledVector(p.velocity, dt)
      p.velocity.multiplyScalar(0.92)
      const t = p.life / p.maxLife
      const opacity = OPACITY * (1 - t)
      ;(p.mesh.material as THREE.PointsMaterial).opacity = opacity
      if (p.life >= p.maxLife) {
        p.mesh.visible = false
        active.splice(i, 1)
        pool.push(p)
      }
    }
  }

  return { spawn, update }
}
