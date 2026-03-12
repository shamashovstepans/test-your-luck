import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'

const DEFAULT_GRAVITY = 9.81
const FIXED_STEP = 1 / 60

// Box dimensions (inner): square base 14x14, height 16 (2x for collider)
const BOX_INNER = { x: 14, y: 16, z: 14 }
const WALL_THICKNESS = 0.05

// Dice: 1 unit cube (half-extent 0.5)
const DICE_HALF = 0.5
const DICE_FRICTION = 0.5
const DICE_RESTITUTION = 0.15

// Spawn inside box: random center with margin from walls
const BOX_MARGIN = 3
const SPAWN_X_MIN = -BOX_INNER.x / 2 + BOX_MARGIN
const SPAWN_X_MAX = BOX_INNER.x / 2 - BOX_MARGIN
const SPAWN_Y_MIN = 5
const SPAWN_Y_MAX = BOX_INNER.y / 2 - BOX_MARGIN
const SPAWN_Z_MIN = -BOX_INNER.z / 2 + BOX_MARGIN
const SPAWN_Z_MAX = BOX_INNER.z / 2 - BOX_MARGIN

// Spawn layouts: generate [x, y, z] offsets for N dice
export type SpawnLayout = 'grid' | 'line' | 'pyramid' | 'circle' | 'corners' | 'diamond' | 'cluster'

export const MIN_DICE = 1
export const MAX_DICE = 50

function getSpawnOffsets(layout: SpawnLayout, count: number): [number, number, number][] {
  const out: [number, number, number][] = []
  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(count))
    const spacing = 1.5
    const start = -((cols - 1) * spacing) / 2
    for (let i = 0; i < count; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      out.push([start + col * spacing, 0, start + row * spacing])
    }
  } else if (layout === 'line') {
    const spacing = count > 1 ? 5 / (count - 1) : 0
    const start = count > 1 ? -2.5 : 0
    for (let i = 0; i < count; i++) {
      out.push([start + i * spacing, 0, 0])
    }
  } else if (layout === 'pyramid') {
    const base: [number, number, number][] = [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0, 0, 0], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0, 2, 0]]
    for (let i = 0; i < count; i++) {
      const idx = i % base.length
      out.push([...base[idx]])
    }
  } else if (layout === 'circle') {
    const r = Math.min(2.5, 1.5 + count * 0.05)
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      out.push([Math.cos(a) * r, 0, Math.sin(a) * r])
    }
  } else if (layout === 'corners') {
    const base = [[-2, 0, -2], [-2, 0, 2], [2, 0, -2], [2, 0, 2], [-1, 0, 0], [1, 0, 0]]
    for (let i = 0; i < count; i++) {
      const idx = i % base.length
      const [x, y, z] = base[idx]
      const jitter = (i / base.length) * 0.3
      out.push([x + (i % 3 - 1) * jitter, y, z + (Math.floor(i / 3) % 3 - 1) * jitter])
    }
  } else if (layout === 'diamond') {
    const base: [number, number, number][] = [[0, 0, 0], [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [1, 0, 1], [0, 1, 0]]
    for (let i = 0; i < count; i++) {
      const idx = i % base.length
      out.push([...base[idx]])
    }
  } else {
    // cluster
    const base = [[0, 0, 0], [0.2, 0, 0], [-0.2, 0, 0.1], [0.1, 0, -0.2], [-0.1, 0.1, 0], [0, -0.1, -0.1]]
    for (let i = 0; i < count; i++) {
      const idx = i % base.length
      const [x, y, z] = base[idx]
      const layer = Math.floor(i / base.length)
      const jitter = 0.15 * layer
      const h = (i * 7) % 11 / 11 - 0.5
      const k = (i * 13) % 7 / 7 - 0.5
      const m = (i * 17) % 5 / 5 - 0.5
      out.push([x + h * jitter, y + k * jitter, z + m * jitter])
    }
  }
  return out
}

export type TargetMode = 'single' | 'spread' | 'corner' | 'center' | 'ring' | 'grid'

export type PatternPreset = 'none' | 'stack' | 'scatter' | 'ring' | 'line'

export type ThrowOptions = {
  seed?: number
  power?: number
  directionSpread?: number
  speedVariation?: number
  rotation?: number
  aimEdge?: boolean
  spawnLayout?: SpawnLayout
  targetMode?: TargetMode
  patternPreset?: PatternPreset
}

export type PhysicsState = {
  world: RAPIER.World
  diceBodies: RAPIER.RigidBody[]
  eventQueue: RAPIER.EventQueue
  pendingThrow: ThrowOptions | null
  simulatingThrow: boolean
  currentMass: number
  currentGravity: number
  diceCount: number
}

function buildWorld(mass: number, gravity: number, diceCount: number): { world: RAPIER.World; diceBodies: RAPIER.RigidBody[]; eventQueue: RAPIER.EventQueue } {
  const count = Math.max(MIN_DICE, Math.min(MAX_DICE, diceCount))
  const world = new RAPIER.World({ x: 0, y: -gravity, z: 0 })
  world.timestep = FIXED_STEP
  // Prevent dice tunneling through walls when thrown fast
  world.integrationParameters.maxCcdSubsteps = 8
  world.integrationParameters.predictionDistance = 0.5
  createBoxWalls(world)
  const diceBodies: RAPIER.RigidBody[] = []
  for (let i = 0; i < count; i++) {
    diceBodies.push(createDiceRigidBody(world, mass))
  }
  return { world, diceBodies, eventQueue: new RAPIER.EventQueue(true) }
}

export function createPhysicsWorld(initialMass = 3, gravity = DEFAULT_GRAVITY, diceCount = 6): PhysicsState {
  const count = Math.max(MIN_DICE, Math.min(MAX_DICE, diceCount))
  const { world, diceBodies, eventQueue } = buildWorld(initialMass, gravity, count)
  return { world, diceBodies, eventQueue, pendingThrow: null, simulatingThrow: false, currentMass: initialMass, currentGravity: gravity, diceCount: count }
}

/** Rebuild world from scratch for determinism */
export function resetWorld(state: PhysicsState): void {
  state.world.free()
  const { world, diceBodies, eventQueue } = buildWorld(state.currentMass, state.currentGravity, state.diceCount)
  state.world = world
  state.diceBodies = diceBodies
  state.eventQueue = eventQueue
  state.simulatingThrow = false
  state.pendingThrow = null
}

export function updateDiceMass(state: PhysicsState, mass: number): void {
  state.currentMass = mass
  const positions: { x: number; y: number; z: number }[] = []
  const rotations: { x: number; y: number; z: number; w: number }[] = []
  for (const rb of state.diceBodies) {
    const t = rb.translation()
    const r = rb.rotation()
    positions.push({ x: t.x, y: t.y, z: t.z })
    rotations.push({ x: r.x, y: r.y, z: r.z, w: r.w })
  }
  for (const rb of state.diceBodies) {
    state.world.removeRigidBody(rb)
  }
  state.diceBodies.length = 0
  const count = state.diceCount
  for (let i = 0; i < count; i++) {
    const rb = createDiceRigidBody(state.world, mass)
    if (i < positions.length) {
      rb.setTranslation(positions[i], true)
      rb.setRotation(rotations[i], true)
    }
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    state.diceBodies.push(rb)
  }
}

function createBoxWalls(world: RAPIER.World): void {
  const hx = BOX_INNER.x / 2
  const hy = BOX_INNER.y / 2
  const hz = BOX_INNER.z / 2
  const t = WALL_THICKNESS

  // 6 walls: floor, left, right, back, front, roof (invisible roof keeps dice in)
  const walls = [
    { pos: [0, -hy - t / 2, 0] as const, half: [hx + t, t / 2, hz + t] as const },
    { pos: [-hx - t / 2, 0, 0] as const, half: [t / 2, hy + t, hz + t] as const },
    { pos: [hx + t / 2, 0, 0] as const, half: [t / 2, hy + t, hz + t] as const },
    { pos: [0, 0, -hz - t / 2] as const, half: [hx + t, hy + t, t / 2] as const },
    { pos: [0, 0, hz + t / 2] as const, half: [hx + t, hy + t, t / 2] as const },
    { pos: [0, hy + t / 2, 0] as const, half: [hx + t, t / 2, hz + t] as const }
  ]

  for (const w of walls) {
    const desc = RAPIER.RigidBodyDesc.fixed()
    const rb = world.createRigidBody(desc)
    rb.setTranslation({ x: w.pos[0], y: w.pos[1], z: w.pos[2] }, true)
    const col = RAPIER.ColliderDesc.cuboid(w.half[0], w.half[1], w.half[2])
      .setFriction(0.5)
      .setRestitution(0.2)
    world.createCollider(col, rb)
  }
}

function createDiceRigidBody(world: RAPIER.World, mass: number): RAPIER.RigidBody {
  const colliderDesc = RAPIER.ColliderDesc.cuboid(DICE_HALF, DICE_HALF, DICE_HALF)
    .setMass(mass)
    .setFriction(DICE_FRICTION)
    .setRestitution(DICE_RESTITUTION)

  const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setLinearDamping(0.1)
    .setAngularDamping(0.2)
    .setCcdEnabled(true)

  const rigidBody = world.createRigidBody(rigidBodyDesc)
  world.createCollider(colliderDesc, rigidBody)

  return rigidBody
}

/** Seeded RNG for deterministic throws (mulberry32) */
function createSeededRandom(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Resolve options from preset (preset overrides spawn/target when set) */
function resolveOptions(options?: ThrowOptions): { spawnLayout: SpawnLayout; targetMode: TargetMode } {
  const preset = options?.patternPreset ?? 'none'
  if (preset === 'stack') return { spawnLayout: 'cluster', targetMode: 'center' }
  if (preset === 'scatter') return { spawnLayout: 'corners', targetMode: 'spread' }
  if (preset === 'ring') return { spawnLayout: 'circle', targetMode: 'ring' }
  if (preset === 'line') return { spawnLayout: 'line', targetMode: 'grid' }
  return {
    spawnLayout: options?.spawnLayout ?? 'grid',
    targetMode: options?.targetMode ?? 'single'
  }
}

/** Get target point for die i based on target mode */
function getTargetForDie(
  i: number,
  count: number,
  targetMode: TargetMode,
  rng: () => number,
  hx: number,
  hz: number,
  aimEdge: boolean
): { x: number; z: number } {
  if (targetMode === 'center') {
    return { x: (rng() - 0.5) * hx * 0.3, z: (rng() - 0.5) * hz * 0.3 }
  }
  if (targetMode === 'corner') {
    const corner = Math.floor(rng() * 4)
    const sx = corner < 2 ? -1 : 1
    const sz = (corner % 2 === 0) ? -1 : 1
    return { x: sx * hx * 0.85, z: sz * hz * 0.85 }
  }
  if (targetMode === 'spread') {
    const edge = i % 4
    if (edge === 0) return { x: (rng() - 0.5) * hx * 1.8, z: -hz * 0.9 }
    if (edge === 1) return { x: (rng() - 0.5) * hx * 1.8, z: hz * 0.9 }
    if (edge === 2) return { x: -hx * 0.9, z: (rng() - 0.5) * hz * 1.8 }
    return { x: hx * 0.9, z: (rng() - 0.5) * hz * 1.8 }
  }
  if (targetMode === 'ring') {
    const r = 3
    const a = (i / Math.max(1, count)) * Math.PI * 2 + rng() * 0.2
    return { x: Math.cos(a) * r, z: Math.sin(a) * r }
  }
  if (targetMode === 'grid') {
    const cols = Math.ceil(Math.sqrt(count))
    const col = i % cols
    const row = Math.floor(i / cols)
    const spacing = 1.8
    return {
      x: (col - (cols - 1) / 2) * spacing + (rng() - 0.5) * 0.3,
      z: (row - 0.5) * spacing + (rng() - 0.5) * 0.3
    }
  }
  // single (default): one target, aim edge or center
  if (aimEdge) {
    const edgeT = rng()
    if (edgeT < 0.25) return { x: (rng() - 0.5) * hx * 1.8, z: -hz * 0.9 }
    if (edgeT < 0.5) return { x: (rng() - 0.5) * hx * 1.8, z: hz * 0.9 }
    if (edgeT < 0.75) return { x: -hx * 0.9, z: (rng() - 0.5) * hz * 1.8 }
    return { x: hx * 0.9, z: (rng() - 0.5) * hz * 1.8 }
  }
  return { x: (rng() - 0.5) * hx * 0.5, z: (rng() - 0.5) * hz * 0.5 }
}

function applyThrow(state: PhysicsState, options?: ThrowOptions): void {
  const seed = options?.seed ?? Date.now()
  const power = options?.power ?? 1
  const directionSpread = options?.directionSpread ?? 0.35
  const speedVariation = options?.speedVariation ?? 0.3
  const rotation = options?.rotation ?? 2
  const aimEdge = options?.aimEdge ?? true
  const rng = createSeededRandom(seed)

  const { spawnLayout, targetMode } = resolveOptions(options)
  const count = state.diceBodies.length
  const offsets = getSpawnOffsets(spawnLayout, count)

  const hx = BOX_INNER.x / 2
  const hz = BOX_INNER.z / 2

  // Random spawn center inside the box
  const centerX = SPAWN_X_MIN + rng() * (SPAWN_X_MAX - SPAWN_X_MIN)
  const centerY = SPAWN_Y_MIN + rng() * (SPAWN_Y_MAX - SPAWN_Y_MIN)
  const centerZ = SPAWN_Z_MIN + rng() * (SPAWN_Z_MAX - SPAWN_Z_MIN)

  // For single target mode, compute one target; for others, per-die
  const singleTarget = targetMode === 'single'
    ? getTargetForDie(0, count, 'single', rng, hx, hz, aimEdge)
    : null

  const targetY = -BOX_INNER.y / 2 + 0.5

  const baseSpeed = (2.5 + rng() * 3) * power

  for (let i = 0; i < state.diceBodies.length; i++) {
    const rb = state.diceBodies[i]
    const [ox, oy, oz] = offsets[i]
    rb.setTranslation({
      x: centerX + ox,
      y: centerY + oy,
      z: centerZ + oz
    }, true)

    const t = singleTarget ?? getTargetForDie(i, count, targetMode, rng, hx, hz, aimEdge)
    let dx = t.x - (centerX + ox)
    let dy = targetY - (centerY + oy)
    let dz = t.z - (centerZ + oz)
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    dx /= len
    dy /= len
    dz /= len

    const dirJitter = directionSpread
    const ndx = dx + (rng() - 0.5) * dirJitter
    const ndy = dy + (rng() - 0.5) * dirJitter
    const ndz = dz + (rng() - 0.5) * dirJitter
    const nlen = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz) || 1
    const spd = baseSpeed * (1 - speedVariation / 2 + rng() * speedVariation)
    rb.setLinvel({
      x: (ndx / nlen) * spd,
      y: (ndy / nlen) * spd,
      z: (ndz / nlen) * spd
    }, true)

    const rotScale = rotation * power
    rb.setAngvel({
      x: (rng() - 0.5) * rotScale,
      y: (rng() - 0.5) * rotScale,
      z: (rng() - 0.5) * rotScale
    }, true)
  }
}

export function setGravity(state: PhysicsState, g: number): void {
  state.currentGravity = g
  state.world.gravity = { x: 0, y: -g, z: 0 }
}

const SETTLE_THRESHOLD_STEP = 0.01

/** Queue throw: reset world first, then queue the throw for determinism. */
export function throwDice(state: PhysicsState, options?: ThrowOptions): void {
  resetWorld(state)
  state.pendingThrow = options ?? null
}

/** Run physics. stepsPerFrame controls simulation speed (1 = normal, higher = faster). */
export function stepPhysics(state: PhysicsState, stepsPerFrame: number): void {
  if (state.simulatingThrow) {
    for (let i = 0; i < stepsPerFrame; i++) {
      state.world.step()
      if (isSettled(state, SETTLE_THRESHOLD_STEP)) {
        state.simulatingThrow = false
        return
      }
    }
    return
  }
  if (state.pendingThrow != null) {
    const opts = state.pendingThrow
    state.pendingThrow = null
    applyThrow(state, opts)
    state.simulatingThrow = true
    for (let i = 0; i < stepsPerFrame; i++) {
      state.world.step()
      if (isSettled(state, SETTLE_THRESHOLD_STEP)) {
        state.simulatingThrow = false
        return
      }
    }
    return
  }
  state.world.step()
}

export function getFixedStep(): number {
  return FIXED_STEP
}

export function isSettled(state: PhysicsState, threshold = 0.01): boolean {
  for (const rb of state.diceBodies) {
    const linvel = rb.linvel()
    const angvel = rb.angvel()
    const linMag = Math.sqrt(linvel.x ** 2 + linvel.y ** 2 + linvel.z ** 2)
    const angMag = Math.sqrt(angvel.x ** 2 + angvel.y ** 2 + angvel.z ** 2)
    if (linMag > threshold || angMag > threshold) return false
  }
  return true
}

/** Check if any die has escaped outside the box (physics glitch / tunneling) */
export function isOutOfBounds(state: PhysicsState): boolean {
  const hx = BOX_INNER.x / 2
  const hy = BOX_INNER.y / 2
  const hz = BOX_INNER.z / 2
  for (const rb of state.diceBodies) {
    const pos = rb.translation()
    if (Math.abs(pos.x) > hx || Math.abs(pos.y) > hy || Math.abs(pos.z) > hz) {
      return true
    }
  }
  return false
}

/** Face normals in local space (Y-up) and their values. +Y=1, -Y=6, +X=3, -X=4, +Z=2, -Z=5 */
const FACE_NORMALS: { n: [number, number, number]; v: number }[] = [
  { n: [0, 1, 0], v: 1 },
  { n: [0, -1, 0], v: 6 },
  { n: [1, 0, 0], v: 3 },
  { n: [-1, 0, 0], v: 4 },
  { n: [0, 0, 1], v: 2 },
  { n: [0, 0, -1], v: 5 }
]

/** Get face-up value for each die. Returns array of 6 values (1-6). */
export function getDiceResult(state: PhysicsState): number[] {
  const result: number[] = []
  const quat = new THREE.Quaternion()
  const normal = new THREE.Vector3()
  for (const rb of state.diceBodies) {
    const r = rb.rotation()
    quat.set(r.x, r.y, r.z, r.w)
    let bestVal = 1
    let bestY = -1
    for (const { n, v } of FACE_NORMALS) {
      normal.set(n[0], n[1], n[2]).applyQuaternion(quat)
      if (normal.y > bestY) {
        bestY = normal.y
        bestVal = v
      }
    }
    result.push(bestVal)
  }
  return result
}

export function syncRigidBodyToMesh(
  rigidBody: RAPIER.RigidBody,
  mesh: { position: { set: (x: number, y: number, z: number) => void }; quaternion: { set: (x: number, y: number, z: number, w: number) => void } }
): void {
  const pos = rigidBody.translation()
  const rot = rigidBody.rotation()
  mesh.position.set(pos.x, pos.y, pos.z)
  mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w)
}
