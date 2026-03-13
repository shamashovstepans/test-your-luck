import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { PMREMGenerator } from 'three'

export type LightingState = {
  mainLight: THREE.DirectionalLight
  ambientLight: THREE.AmbientLight
}

export type SceneState = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
  lighting: LightingState
}

/** Create dice-model environment (RoomEnvironment). Needs a WebGLRenderer for PMREMGenerator. */
export function createDiceModelEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmremGenerator = new PMREMGenerator(renderer)
  const envScene = new RoomEnvironment()
  const envMap = pmremGenerator.fromScene(envScene).texture
  pmremGenerator.dispose()
  envScene.dispose()
  return envMap
}

export function createScene(container: HTMLElement, envMap?: THREE.Texture): SceneState {
  const scene = new THREE.Scene()

  const aspect = container.clientWidth / container.clientHeight
  const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000)
  camera.position.set(30, 20, 30)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false,
    failIfMajorPerformanceCaveat: false
  })
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  // Lighting - same as dice model: ambient + single directional
  const ambient = new THREE.AmbientLight(0xffffff, 0.35)
  scene.add(ambient)

  const mainLight = new THREE.DirectionalLight(0xffffff, 0.8)
  mainLight.position.set(5, 8, 5) // azimuth 45°, elevation ~48°
  mainLight.castShadow = true
  mainLight.shadow.mapSize.width = 512
  mainLight.shadow.mapSize.height = 512
  mainLight.shadow.camera.near = 0.5
  mainLight.shadow.camera.far = 60
  mainLight.shadow.camera.left = -30
  mainLight.shadow.camera.right = 30
  mainLight.shadow.camera.top = 30
  mainLight.shadow.camera.bottom = -30
  mainLight.shadow.bias = -0.0001
  scene.add(mainLight)

  // Environment for dice reflections; background is black
  const env = envMap ?? createDiceModelEnvironment(renderer)
  scene.environment = env
  scene.background = new THREE.Color(0x000000)

  // Ground plane — gives spatial context and scale for the dice area
  const groundSize = 180
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize)
  const groundMat = new THREE.MeshPhysicalMaterial({
    color: 0x0d0d0d,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.15,
    clearcoat: 0
  })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -9
  ground.receiveShadow = true
  scene.add(ground)

  // Subtle fog for depth
  scene.fog = new THREE.Fog(0x0a0a0a, 60, 140)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.05
  controls.target.set(0, 0, 0)
  controls.minDistance = 5
  controls.maxDistance = 200

  return { scene, camera, renderer, controls, lighting: { mainLight, ambientLight: ambient } }
}

/** Enable performance mode: lower shadow resolution and pixel ratio for slow browsers. */
export function setPerformanceMode(state: SceneState, container: HTMLElement): void {
  state.lighting.mainLight.shadow.mapSize.width = 256
  state.lighting.mainLight.shadow.mapSize.height = 256
  state.renderer.setPixelRatio(1)
  state.renderer.setSize(container.clientWidth, container.clientHeight)
}

/** Set main light direction from azimuth (0–360°) and elevation (0–90°). Distance from target. */
export function setMainLightDirection(light: THREE.DirectionalLight, azimuthDeg: number, elevationDeg: number, distance = 15): void {
  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  light.position.set(
    distance * Math.cos(el) * Math.sin(az),
    distance * Math.sin(el),
    distance * Math.cos(el) * Math.cos(az)
  )
}

export function onResize(
  state: SceneState,
  container: HTMLElement
): void {
  const width = container.clientWidth
  const height = container.clientHeight
  state.camera.aspect = width / height
  state.camera.updateProjectionMatrix()
  state.renderer.setSize(width, height)
}

const ROOM_SPACING = 20

export type CameraView = 'top' | 'bottom'

/** Compute camera position and target for all-rooms view. Top-down or bottom-up vertical view. */
export function getCameraForAllRooms(gridSide: number, spacing = ROOM_SPACING, zoom = 1, view: CameraView = 'top'): { position: THREE.Vector3; target: THREE.Vector3 } {
  const extent = (gridSide - 1) * spacing * 0.5
  const baseHeight = Math.max(80, extent * 3.5)
  const height = baseHeight / zoom
  const y = view === 'top' ? height : -height
  return {
    position: new THREE.Vector3(0, y, 0),
    target: new THREE.Vector3(0, 0, 0)
  }
}

/** Default camera position and target for single-room preview (top view). */
const DEFAULT_PREVIEW_CAMERA = {
  position: new THREE.Vector3(-13.82, 0.1, 13.79),
  target: new THREE.Vector3(-4.42, -6.35, 3.91)
}

/** Compute camera position and target for a single room. Perpendicular views: top-down or bottom-up (dice falling at camera). */
export function getCameraForRoom(roomCenter: THREE.Vector3, view: CameraView = 'top'): { position: THREE.Vector3; target: THREE.Vector3 } {
  if (view === 'top') {
    return {
      position: roomCenter.clone().add(DEFAULT_PREVIEW_CAMERA.position),
      target: roomCenter.clone().add(DEFAULT_PREVIEW_CAMERA.target)
    }
  }
  const offset = new THREE.Vector3(0, -15, 0)
  return {
    position: roomCenter.clone().add(offset),
    target: roomCenter.clone()
  }
}

export type CameraAnimationState = {
  fromPos: THREE.Vector3
  fromTarget: THREE.Vector3
  toPos: THREE.Vector3
  toTarget: THREE.Vector3
  progress: number
  duration: number
  startTime: number
}

/** Start a camera fly animation. Returns state to pass to updateCameraAnimation. */
export function startCameraAnimation(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  toPos: THREE.Vector3,
  toTarget: THREE.Vector3,
  duration = 0.5
): CameraAnimationState {
  const fromPos = camera.position.clone()
  const fromTarget = controls.target.clone()
  return {
    fromPos,
    fromTarget,
    toPos: toPos.clone(),
    toTarget: toTarget.clone(),
    progress: 0,
    duration,
    startTime: performance.now() / 1000
  }
}

/** Update camera animation. Returns true when complete. */
export function updateCameraAnimation(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  state: CameraAnimationState
): boolean {
  const t = (performance.now() / 1000 - state.startTime) / state.duration
  const s = Math.min(1, t < 0 ? 0 : t)
  const smooth = s * s * (3 - 2 * s) // smoothstep
  camera.position.lerpVectors(state.fromPos, state.toPos, smooth)
  controls.target.lerpVectors(state.fromTarget, state.toTarget, smooth)
  return s >= 1
}
