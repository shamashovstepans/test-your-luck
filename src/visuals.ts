import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

// Box dimensions: physics floor/roof match physics.ts; visible walls are lower
const BOX_X = 14
const BOX_Z = 14
const PHYSICS_HEIGHT = 16
const VISUAL_WALL_HEIGHT = 4
const WALL_THICKNESS = 0.05
const BORDER_WIDTH = 0.8

// Box colors — dark charcoal so the tray reads as a space
const BOX_FLOOR = 0x0f0f0f
const BOX_WALL_BASE = 0x121212
const EDGE_COLOR = 0x1a1a1a
const BORDER_ACCENT = 0x0f0f0f
const INNER_FLOOR = 0x0a0a0a

// Professional transparent red matte — all dice share this look
const DICE_RED = 0xb91c1c

// Shared grid texture for playing surface (created once)
function createGridTexture(): THREE.CanvasTexture {
  const gridSize = 64
  const canvas = document.createElement('canvas')
  canvas.width = gridSize
  canvas.height = gridSize
  const g = canvas.getContext('2d')!
  g.fillStyle = '#0a0a0a'
  g.fillRect(0, 0, gridSize, gridSize)
  g.strokeStyle = '#1a1a1a'
  g.lineWidth = 1
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * gridSize
    g.beginPath()
    g.moveTo(p, 0)
    g.lineTo(p, gridSize)
    g.stroke()
    g.beginPath()
    g.moveTo(0, p)
    g.lineTo(gridSize, p)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(4, 4)
  return tex
}
const gridTex = createGridTexture()

/** Soft radial gradient: transparent center, opaque edges. Used for obstructing wall fade. */
function createWallAlphaGradientTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const r = size / 2
  const gradient = g.createRadialGradient(cx, cy, 0, cx, cy, r)
  gradient.addColorStop(0, 'rgba(0,0,0,0)')
  gradient.addColorStop(0.4, 'rgba(0,0,0,0.3)')
  gradient.addColorStop(0.7, 'rgba(0,0,0,0.7)')
  gradient.addColorStop(1, 'rgba(0,0,0,1)')
  g.fillStyle = gradient
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}
const wallAlphaGradientTex = createWallAlphaGradientTexture()

export const BOX_HALF_X = BOX_X / 2
export const BOX_HALF_Z = BOX_Z / 2

/** Add wooden box meshes to a parent (group or scene). Box is at local origin. */
export function createWoodenBox(parent: THREE.Object3D): void {
  const boxGroup = new THREE.Group()

  const hx = BOX_X / 2
  const hz = BOX_Z / 2
  const t = WALL_THICKNESS
  const physicsHy = PHYSICS_HEIGHT / 2
  const floorY = -physicsHy - t / 2

  const floorMat = new THREE.MeshPhysicalMaterial({
    color: BOX_FLOOR,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0,
    clearcoat: 0
  })
  const addEdges = (mesh: THREE.Mesh, color: number) => {
    const edges = new THREE.EdgesGeometry(mesh.geometry, 15)
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color }))
    mesh.add(line)
  }

  // Floor (aligned with physics)
  const floorGeo = new THREE.BoxGeometry(BOX_X + t * 2, t, BOX_Z + t * 2)
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.position.set(0, floorY, 0)
  floor.castShadow = true
  floor.receiveShadow = true
  addEdges(floor, EDGE_COLOR)
  boxGroup.add(floor)

  // Inner playing surface (recessed look) + border
  const innerY = floorY + t / 2 + 0.01
  const innerW = BOX_X - BORDER_WIDTH * 2
  const innerD = BOX_Z - BORDER_WIDTH * 2
  const innerMat = new THREE.MeshPhysicalMaterial({
    color: INNER_FLOOR,
    map: gridTex,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0,
    clearcoat: 0
  })
  const innerGeo = new THREE.PlaneGeometry(innerW, innerD)
  const innerFloor = new THREE.Mesh(innerGeo, innerMat)
  innerFloor.rotation.x = -Math.PI / 2
  innerFloor.position.set(0, innerY, 0)
  innerFloor.receiveShadow = true
  boxGroup.add(innerFloor)

  // Border strips
  const borderMat = new THREE.MeshPhysicalMaterial({
    color: BORDER_ACCENT,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0,
    clearcoat: 0
  })
  const bw = BORDER_WIDTH
  const borderStrips = [
    { pos: [0, innerY, -hz], size: [BOX_X, 0.02, bw] as [number, number, number] },
    { pos: [0, innerY, hz], size: [BOX_X, 0.02, bw] as [number, number, number] },
    { pos: [-hx, innerY, 0], size: [bw, 0.02, BOX_Z] as [number, number, number] },
    { pos: [hx, innerY, 0], size: [bw, 0.02, BOX_Z] as [number, number, number] }
  ]
  for (const s of borderStrips) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]), borderMat)
    strip.position.set(s.pos[0], s.pos[1], s.pos[2])
    strip.receiveShadow = true
    boxGroup.add(strip)
  }

  // 4 walls (lower than physics box - visual only). Each has own material for obstruction transparency.
  const wallCenterY = floorY + t / 2 + VISUAL_WALL_HEIGHT / 2
  const wallSpecs: { pos: [number, number, number]; size: [number, number, number]; side: 'left' | 'right' | 'back' | 'front' }[] = [
    { pos: [-hx - t / 2, wallCenterY, 0], size: [t, VISUAL_WALL_HEIGHT + t * 2, BOX_Z + t * 2], side: 'left' },
    { pos: [hx + t / 2, wallCenterY, 0], size: [t, VISUAL_WALL_HEIGHT + t * 2, BOX_Z + t * 2], side: 'right' },
    { pos: [0, wallCenterY, -hz - t / 2], size: [BOX_X + t * 2, VISUAL_WALL_HEIGHT + t * 2, t], side: 'back' },
    { pos: [0, wallCenterY, hz + t / 2], size: [BOX_X + t * 2, VISUAL_WALL_HEIGHT + t * 2, t], side: 'front' }
  ]

  for (const w of wallSpecs) {
    const wallMat = new THREE.MeshPhysicalMaterial({
      color: BOX_WALL_BASE,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0,
      clearcoat: 0
    })
    const wallGeo = new RoundedBoxGeometry(w.size[0], w.size[1], w.size[2], 2, 0.08)
    const wall = new THREE.Mesh(wallGeo, wallMat)
    wall.position.set(w.pos[0], w.pos[1], w.pos[2])
    wall.castShadow = true
    wall.receiveShadow = true
    wall.userData = { wallSide: w.side }
    addEdges(wall, EDGE_COLOR)
    boxGroup.add(wall)
  }

  // Corner accents (vertical strips)
  const cornerAccentMat = new THREE.MeshPhysicalMaterial({
    color: BORDER_ACCENT,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0,
    clearcoat: 0
  })
  const cornerH = VISUAL_WALL_HEIGHT * 0.4
  const cornerW = 0.12
  const cornerY = floorY + t / 2 + cornerH / 2
  const corners = [
    [-hx - t / 2, -hz - t / 2], [hx + t / 2, -hz - t / 2],
    [-hx - t / 2, hz + t / 2], [hx + t / 2, hz + t / 2]
  ]
  for (const [cx, cz] of corners) {
    const corner = new THREE.Mesh(
      new RoundedBoxGeometry(cornerW, cornerH, cornerW, 1, 0.02),
      cornerAccentMat
    )
    corner.position.set(cx, cornerY, cz)
    corner.castShadow = true
    boxGroup.add(corner)
  }

  parent.add(boxGroup)
}

const WALL_OBSTRUCT_OPACITY = 0.35

/** Update wall transparency based on camera position. Walls between camera and dice center become semi-transparent with soft border. */
export function updateWallTransparency(
  roomGroup: THREE.Group,
  cameraPosition: THREE.Vector3,
  hx: number = BOX_HALF_X,
  hz: number = BOX_HALF_Z
): void {
  const boxGroup = roomGroup.children[0]
  if (!boxGroup) return

  const center = new THREE.Vector3()
  roomGroup.getWorldPosition(center)

  const obstructLeft = cameraPosition.x < center.x - hx
  const obstructRight = cameraPosition.x > center.x + hx
  const obstructBack = cameraPosition.z < center.z - hz
  const obstructFront = cameraPosition.z > center.z + hz

  for (const child of boxGroup.children) {
    if (!(child instanceof THREE.Mesh) || child.userData.wallSide == null) continue

    const obstructing = {
      left: obstructLeft,
      right: obstructRight,
      back: obstructBack,
      front: obstructFront
    }[child.userData.wallSide as string]

    const mat = child.material
    if (!(mat instanceof THREE.MeshPhysicalMaterial)) continue

    if (obstructing) {
      mat.transparent = true
      mat.opacity = WALL_OBSTRUCT_OPACITY
      mat.alphaMap = wallAlphaGradientTex
      mat.alphaTest = 0.01
      mat.depthWrite = false
      const edges = child.children[0]
      if (edges instanceof THREE.LineSegments && edges.material instanceof THREE.LineBasicMaterial) {
        edges.material.transparent = true
        edges.material.opacity = 0.5
      }
    } else {
      mat.transparent = false
      mat.opacity = 1
      mat.alphaMap = null
      mat.alphaTest = 0
      mat.depthWrite = true
      const edges = child.children[0]
      if (edges instanceof THREE.LineSegments && edges.material instanceof THREE.LineBasicMaterial) {
        edges.material.transparent = false
        edges.material.opacity = 1
      }
    }
  }
}

export type RoomVisuals = {
  group: THREE.Group
  diceMeshes: THREE.Object3D[]
}

/** Create a room's visuals (box + dice) in a group. Position the group at (offsetX, 0, offsetZ). */
export function createRoomVisuals(parent: THREE.Object3D, roomIndex: number, offsetX: number, offsetZ: number, glossiness: number = DEFAULT_GLOSSINESS, diceCount: number = 6): RoomVisuals {
  const group = new THREE.Group()
  group.position.set(offsetX, 0, offsetZ)
  group.userData = { roomIndex }
  createWoodenBox(group)
  const diceMeshes = createDiceMeshesInGroup(group, glossiness, diceCount)
  parent.add(group)
  return { group, diceMeshes }
}

function createDiceMeshesInGroup(parent: THREE.Object3D, glossiness: number = DEFAULT_GLOSSINESS, diceCount: number = 6): THREE.Object3D[] {
  const meshes: THREE.Object3D[] = []
  const count = Math.max(1, Math.min(50, diceCount))
  for (let i = 0; i < count; i++) {
    const group = createDiceWithPips(DICE_RED, glossiness)
    group.castShadow = true
    group.receiveShadow = true
    parent.add(group)
    meshes.push(group)
  }
  return meshes
}

// Standard dice: opposite faces sum to 7. Face value for each cube face.
// +Y=1, -Y=6, +X=3, -X=4, +Z=2, -Z=5
const FACE_VALUES = [1, 6, 3, 4, 2, 5] // +Y, -Y, +X, -X, +Z, -Z

// Pip positions in face-local coords (normalized -0.5 to 0.5), per value 1-6
const PIP_LAYOUTS: [number, number][][] = [
  [], // 0 unused
  [[0, 0]], // 1
  [[-0.25, -0.25], [0.25, 0.25]], // 2
  [[-0.25, -0.25], [0, 0], [0.25, 0.25]], // 3
  [[-0.25, -0.25], [-0.25, 0.25], [0.25, -0.25], [0.25, 0.25]], // 4
  [[-0.25, -0.25], [-0.25, 0.25], [0.25, -0.25], [0.25, 0.25], [0, 0]], // 5
  [[-0.25, -0.25], [-0.25, 0], [-0.25, 0.25], [0.25, -0.25], [0.25, 0], [0.25, 0.25]] // 6
]

// For each face: [axis, sign, uAxis, vAxis] - face at axis=sign*0.5, u/v are the other two
const FACE_AXES: [number, number, number, number][] = [
  [1, 1, 0, 2],   // +Y: y=0.5, u=x, v=z
  [1, -1, 0, 2],  // -Y
  [0, 1, 1, 2],   // +X: x=0.5, u=y, v=z
  [0, -1, 1, 2],  // -X
  [2, 1, 0, 1],   // +Z: z=0.5, u=x, v=y
  [2, -1, 0, 1]   // -Z
]

const PIP_RADIUS = 0.08

/** Glossiness 0–1: 0 = matte, 1 = mirror-like. Maps to roughness = 1 - glossiness. */
const DEFAULT_GLOSSINESS = 0.88

/** Create solid red dice material with refraction (pips printed on top). */
function createDiceMaterial(color: number, glossiness: number = DEFAULT_GLOSSINESS): THREE.MeshPhysicalMaterial {
  const roughness = 1 - glossiness
  return new THREE.MeshPhysicalMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    transmission: 0.9,
    thickness: 0.5,
    ior: 1.5,
    roughness,
    metalness: 0,
    envMapIntensity: 1.2,
    clearcoat: 0.15,
    clearcoatRoughness: roughness,
    side: THREE.DoubleSide
  })
}

/** Flat circle for printed-on pips. CircleGeometry is in XY plane by default. */
const pipGeo = new THREE.CircleGeometry(PIP_RADIUS, 24)

function createDiceWithPips(color: number, glossiness: number = DEFAULT_GLOSSINESS): THREE.Group {
  const group = new THREE.Group()

  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const boxMat = createDiceMaterial(color, glossiness)
  const box = new THREE.Mesh(boxGeo, boxMat)
  box.castShadow = true
  box.receiveShadow = true
  group.add(box)

  const edges = new THREE.EdgesGeometry(boxGeo, 20)
  const edgeLine = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x4a0a0a, transparent: true, opacity: 0.5 })
  )
  box.add(edgeLine)

  const pipMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide
  })

  // Per-face: rotation so flat circle faces outward (CircleGeometry default: XY plane, normal +Z)
  const FACE_PIP_CONFIG: { rot: [number, number, number] }[] = [
    { rot: [-Math.PI / 2, 0, 0] },   // +Y: circle in XZ plane
    { rot: [Math.PI / 2, 0, 0] },    // -Y
    { rot: [0, Math.PI / 2, 0] },    // +X: circle in YZ plane
    { rot: [0, -Math.PI / 2, 0] },   // -X
    { rot: [0, 0, 0] },              // +Z: circle in XY plane
    { rot: [0, Math.PI, 0] }         // -Z
  ]

  for (let f = 0; f < 6; f++) {
    const value = FACE_VALUES[f]
    const [axis, sign, uAxis, vAxis] = FACE_AXES[f]
    const pips = PIP_LAYOUTS[value]
    const { rot } = FACE_PIP_CONFIG[f]

    for (const [u, v] of pips) {
      const pos = [0, 0, 0] as [number, number, number]
      pos[axis] = sign * 0.501
      pos[uAxis] = u
      pos[vAxis] = v
      const pip = new THREE.Mesh(pipGeo, pipMat)
      pip.position.set(pos[0], pos[1], pos[2])
      pip.rotation.set(rot[0], rot[1], rot[2])
      pip.castShadow = true
      group.add(pip)
    }
  }

  return group
}

/** Add dice meshes to a parent. For backward compat / single-room use. */
export function createDiceMeshes(scene: THREE.Scene, glossiness: number = DEFAULT_GLOSSINESS): THREE.Object3D[] {
  return createDiceMeshesInGroup(scene, glossiness)
}

/** Update glossiness on existing dice meshes. Glossiness 0–1: 0 = matte, 1 = mirror-like. */
export function setDiceGlossiness(diceMeshes: THREE.Object3D[], glossiness: number): void {
  const roughness = 1 - glossiness
  for (const group of diceMeshes) {
    const box = group.children[0]
    if (box instanceof THREE.Mesh && box.material instanceof THREE.MeshPhysicalMaterial) {
      box.material.roughness = roughness
      box.material.clearcoatRoughness = roughness
    }
  }
}

/** Create a single dice model (for preview/display). */
export function createSingleDice(glossiness: number = DEFAULT_GLOSSINESS): THREE.Group {
  const group = createDiceWithPips(DICE_RED, glossiness)
  group.castShadow = true
  group.receiveShadow = true
  return group
}

/** Combo slug for color lookup (matches badge-combo-* CSS). */
function comboSlug(combo: string): string {
  return combo.toLowerCase().replace(/\s+/g, '-')
}

/** Combo colors for dice VFX (hex). Matches badge colors from styles. */
const COMBO_COLORS: Record<string, number> = {
  'single': 0x95a5a6,
  'pair': 0x3498db,
  'triple': 0x2ecc71,
  'quad': 0x9b59b6,
  'five': 0xf1c40f,
  'six': 0xe74c3c,
  'small-straight': 0x1abc9c,
  'large-straight': 0x8e44ad,
  'full-house': 0xe67e22,
  'six-of-a-kind': 0xc0392b
}

/** Rarity rank: higher = rarer. Used when a die belongs to multiple groups. */
const COMBO_RARITY: Record<string, number> = {
  'single': 0,
  'pair': 1,
  'triple': 2,
  'quad': 3,
  'five': 4,
  'six': 5,
  'small-straight': 6,
  'full-house': 7,
  'large-straight': 8,
  'six-of-a-kind': 9
}

export type ComboBadge = { combo: string; values: number[] }

/** For each badge, collect die indices that belong to it (by matching values). */
function collectBadgeDice(diceResult: number[], badges: ComboBadge[]): Map<number, Set<number>> {
  const badgeToDice = new Map<number, Set<number>>()
  badges.forEach((badge, bi) => {
    const valueCounts: Record<number, number> = {}
    for (const v of badge.values) valueCounts[v] = (valueCounts[v] ?? 0) + 1
    const dice = new Set<number>()
    for (let i = 0; i < diceResult.length; i++) {
      const v = diceResult[i]
      if ((valueCounts[v] ?? 0) > 0) {
        valueCounts[v]!--
        dice.add(i)
      }
    }
    badgeToDice.set(bi, dice)
  })
  return badgeToDice
}

/** Assign each die to the rarest combo it belongs to. Dice in 2+ groups use rarest color. */
function assignDiceToRarestCombo(diceResult: number[], badges: ComboBadge[]): (string | null)[] {
  const badgeToDice = collectBadgeDice(diceResult, badges)
  const dieToBadges = new Map<number, number[]>()
  badgeToDice.forEach((dice, bi) => {
    for (const i of dice) {
      if (!dieToBadges.has(i)) dieToBadges.set(i, [])
      dieToBadges.get(i)!.push(bi)
    }
  })
  const result: (string | null)[] = []
  for (let i = 0; i < diceResult.length; i++) {
    const badgeIndices = dieToBadges.get(i) ?? []
    if (badgeIndices.length === 0) {
      result.push(null)
      continue
    }
    const rarest = badgeIndices.reduce((best, bi) => {
      const r = COMBO_RARITY[comboSlug(badges[bi].combo)] ?? 0
      const bestR = COMBO_RARITY[comboSlug(badges[best].combo)] ?? 0
      return r > bestR ? bi : best
    }, badgeIndices[0])
    result.push(badges[rarest].combo)
  }
  return result
}

/** Apply combo VFX to dice when settled: tint + emissive glow by combination. */
export function applyDiceComboVFX(
  diceMeshes: THREE.Object3D[],
  diceResult: number[],
  badges: ComboBadge[]
): void {
  const comboPerDie = assignDiceToRarestCombo(diceResult, badges)
  for (let i = 0; i < diceMeshes.length; i++) {
    const group = diceMeshes[i]
    const box = group.children[0]
    if (!(box instanceof THREE.Mesh) || !(box.material instanceof THREE.MeshPhysicalMaterial)) continue
    const mat = box.material
    const combo = comboPerDie[i] ?? null
    if (combo) {
      const slug = comboSlug(combo)
      const colorHex = COMBO_COLORS[slug] ?? COMBO_COLORS['single']
      mat.color.setHex(colorHex)
      mat.emissive.setHex(colorHex)
      mat.emissiveIntensity = 0.25
    } else {
      mat.color.setHex(DICE_RED)
      mat.emissive.setHex(0x000000)
      mat.emissiveIntensity = 0
    }
  }
}

/** Clear combo VFX and restore default dice appearance. */
export function clearDiceComboVFX(diceMeshes: THREE.Object3D[]): void {
  for (const group of diceMeshes) {
    const box = group.children[0]
    if (box instanceof THREE.Mesh && box.material instanceof THREE.MeshPhysicalMaterial) {
      const mat = box.material
      mat.color.setHex(DICE_RED)
      mat.emissive.setHex(0x000000)
      mat.emissiveIntensity = 0
    }
  }
}
