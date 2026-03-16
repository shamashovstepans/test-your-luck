import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { inject, track } from '@vercel/analytics'
import { createScene, createDiceModelEnvironment, onResize, setPerformanceMode, getCameraForAllRooms, getCameraForRoom, startCameraAnimation, updateCameraAnimation, setMainLightDirection, type CameraAnimationState, type CameraView } from './scene'
import { initRapier, createPhysicsWorld, throwDice, stepPhysics, isSettled, isOutOfBounds, syncRigidBodyToMesh, updateDiceMass, setGravity, getDiceResult, getFixedStep, type PhysicsState, type ThrowOptions, type SpawnLayout, type TargetMode, type PatternPreset } from './physics'
import { createRoomVisuals, createSingleDice, setDiceGlossiness, updateWallTransparency, applyDiceComboVFX, clearDiceComboVFX, setDiceComboColors, setDiceDefaultColor, getDefaultDiceColors } from './visuals'
import {
  getAchievementsToClaim,
  claimAchievements,
  getAchievementDisplayName,
  TOTAL_ACHIEVEMENTS,
  loadClaimedAchievements,
  getAchievementsGroupedByRarity
} from './achievements'

const SETTLE_THRESHOLD = 0.01
const USER_ID_COOKIE = 'dice_user_id'
const USER_ID_MAX_AGE = 365 * 24 * 60 * 60

function getOrCreateUserId(): string {
  const match = document.cookie.match(new RegExp(`${USER_ID_COOKIE}=([^;]+)`))
  if (match) return decodeURIComponent(match[1].trim())
  const id = crypto.randomUUID?.() ?? `d${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  document.cookie = `${USER_ID_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${USER_ID_MAX_AGE}; samesite=lax`
  return id
}
const BASE_SETTLE_FRAMES = 10
const BASE_LOOP_DELAY_MS = 1000
const ROOM_SPACING = 20

type ThrowRecord = { seed: number; options: ThrowOptions; weight: number; gravity: number }
type HistoryEntry = ThrowRecord & { diceResult: number[]; escaped?: boolean; time: number; roomIndex: number; score: number }

type ComboBadge = { combo: string; values: number[]; scoreDisplay: string }

type ScoreBreakdown = {
  score: number
  steps: { value: number; count: number; mult: number; contrib: number; combo: string }[]
  badges: ComboBadge[]
  basicTotal: number
  extraCombo: string | null
  extraMult: number
  rarityTier: number
}

/** Rarity tier 0–5: higher = rarer. Used for color/effect emphasis. */
function getRarityTier(breakdown: { extraCombo: string | null; extraMult: number; steps: { mult: number }[] }): number {
  const maxBasicMult = Math.max(1, ...breakdown.steps.map((s) => s.mult))
  if (breakdown.extraCombo) {
    if (breakdown.extraMult >= 6) return 5
    if (breakdown.extraMult >= 5) return 4
    if (breakdown.extraMult >= 4) return 3
    if (breakdown.extraMult >= 3) return 2
  }
  if (maxBasicMult >= 6) return 5
  if (maxBasicMult >= 5) return 4
  if (maxBasicMult >= 4) return 3
  if (maxBasicMult >= 3) return 2
  if (maxBasicMult >= 2) return 1
  return 0
}

const COMBO_NAMES: Record<number, string> = {
  1: 'single',
  2: 'pair',
  3: 'triple',
  4: 'quad',
  5: 'five',
  6: 'six'
}

function computeScoreBreakdown(diceResult: number[]): ScoreBreakdown {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  for (const v of diceResult) counts[v] = (counts[v] ?? 0) + 1

  const steps: ScoreBreakdown['steps'] = []
  let basic = 0
  for (let v = 1; v <= 6; v++) {
    const n = counts[v] ?? 0
    if (n === 0) continue
    const mult = n >= 2 ? n : 1
    const contrib = v * n * mult
    basic += contrib
    steps.push({ value: v, count: n, mult, contrib, combo: COMBO_NAMES[mult] ?? `×${mult}` })
  }

  let extraMult = 1
  let extraCombo: string | null = null
  const hasSix = Object.values(counts).some((c) => c === 6)
  const sorted = [...diceResult].sort((a, b) => a - b)
  const hasLarge = diceResult.length === 6 && sorted.join('') === '123456'
  const hasSmall = ['12345', '23456'].some((s) =>
    s.split('').every((d) => (counts[+d] ?? 0) >= 1)
  )

  const singleSteps = steps.filter((s) => s.mult === 1)
  const multiSteps = steps.filter((s) => s.mult > 1)
  const badges: ComboBadge[] = []

  if (singleSteps.length > 0) {
    const singleValues = singleSteps.flatMap((s) => Array(s.count).fill(s.value))
    const singleContrib = singleSteps.reduce((sum, s) => sum + s.contrib, 0)
    badges.push({ combo: 'single', values: singleValues, scoreDisplay: `+${singleContrib}` })
  }
  multiSteps.forEach((s) => {
    badges.push({ combo: s.combo, values: Array(s.count).fill(s.value), scoreDisplay: `+${s.contrib}` })
  })

  if (hasSix) {
    extraMult = 6
    extraCombo = 'Six of a kind ×6'
  } else if (hasLarge) {
    extraMult = 4
    extraCombo = 'Large straight ×4'
    badges.push({ combo: 'Large straight', values: [1, 2, 3, 4, 5, 6], scoreDisplay: `×${extraMult}` })
  } else if (hasSmall) {
    extraMult = 3
    extraCombo = 'Small straight ×3'
    const vals = [2, 3, 4, 5, 6].every((d) => (counts[d] ?? 0) >= 1) ? [2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]
    badges.push({ combo: 'Small straight', values: vals, scoreDisplay: `×${extraMult}` })
  }

  const result = { score: basic * extraMult, steps, badges, basicTotal: basic, extraCombo, extraMult, rarityTier: 0 }
  result.rarityTier = getRarityTier(result)
  return result
}

function computeScore(diceResult: number[]): number {
  return computeScoreBreakdown(diceResult).score
}

type RoomState = {
  physics: PhysicsState
  diceMeshes: THREE.Object3D[]
  group: THREE.Group
  roomIndex: number
  lastThrow: ThrowRecord | null
  hasRecordedThisThrow: boolean
  settledFrameCount: number
  lastThrowTime: number
}

type ScreenMode = 'sixes' | 'grid' | 'preview' | 'probability'

async function init() {
  inject()
  getOrCreateUserId()
  await initRapier()
  const app = document.getElementById('app')!
  const container = document.getElementById('canvas-container')!
  const glossinessSlider = document.getElementById('glossiness') as HTMLInputElement
  const getGlossiness = () => parseFloat(glossinessSlider?.value ?? '0.88')

  // Dice model (source of truth): create env and dice first, then main scene uses them
  const dicePreviewContainer = document.getElementById('dice-preview-container')!
  const dicePreviewCanvas = document.getElementById('dice-preview-canvas') as HTMLCanvasElement
  const dicePreviewRenderer = new THREE.WebGLRenderer({
    canvas: dicePreviewCanvas,
    antialias: true,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false
  })
  dicePreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  const diceModelEnv = createDiceModelEnvironment(dicePreviewRenderer)
  const dicePreviewScene = new THREE.Scene()
  dicePreviewScene.environment = diceModelEnv
  dicePreviewScene.background = new THREE.Color(0x000000)
  const diceModel = createSingleDice(getGlossiness())
  dicePreviewScene.add(diceModel)

  const sceneState = createScene(container, diceModelEnv)
  const { scene, camera, renderer, controls, lighting } = sceneState

  const weightSlider = document.getElementById('dice-weight') as HTMLInputElement
  const weightValue = document.getElementById('weight-value')!
  const gravitySlider = document.getElementById('gravity') as HTMLInputElement
  const gravityValue = document.getElementById('gravity-value')!
  const getWeight = () => parseFloat(weightSlider?.value ?? '3')
  const getGravity = () => parseFloat(gravitySlider?.value ?? '9.81')

  const glossinessValue = document.getElementById('glossiness-value')!
  const lightIntensitySlider = document.getElementById('light-intensity') as HTMLInputElement
  const lightIntensityValue = document.getElementById('light-intensity-value')!
  const lightAzimuthSlider = document.getElementById('light-azimuth') as HTMLInputElement
  const lightAzimuthValue = document.getElementById('light-azimuth-value')!
  const lightElevationSlider = document.getElementById('light-elevation') as HTMLInputElement
  const lightElevationValue = document.getElementById('light-elevation-value')!
  const lightColorInput = document.getElementById('light-color') as HTMLInputElement
  const lightColorValue = document.getElementById('light-color-value')!
  const lightAmbientSlider = document.getElementById('light-ambient') as HTMLInputElement
  const lightAmbientValue = document.getElementById('light-ambient-value')!
  const diceCountSlider = document.getElementById('dice-count') as HTMLInputElement
  const diceCountValueEl = document.getElementById('dice-count-value')!
  const gridSideSlider = document.getElementById('grid-side') as HTMLInputElement
  const gridSideValueEl = document.getElementById('grid-side-value')!
  const maxConcurrentSlider = document.getElementById('max-concurrent') as HTMLInputElement
  const maxConcurrentValueEl = document.getElementById('max-concurrent-value')!
  const allRoomsBtn = document.getElementById('all-rooms-btn')!
  const backToGridBtn = document.getElementById('back-to-grid-btn')!
  const gridZoomSlider = document.getElementById('grid-zoom') as HTMLInputElement
  const gridZoomValueEl = document.getElementById('grid-zoom-value')!
  const tabSixes = document.getElementById('tab-sixes')!
  const tabGrid = document.getElementById('tab-grid')!
  const tabPreview = document.getElementById('tab-preview')!
  const tabProbability = document.getElementById('tab-probability')!
  const canvasContainer = document.getElementById('canvas-container')!
  const probabilityPanel = document.getElementById('probability-panel')!
  const probabilityChartSum = document.getElementById('probability-chart-sum')!
  const probabilityLegendSum = document.getElementById('probability-legend-sum')!
  const probabilityChartPattern = document.getElementById('probability-chart-pattern')!
  const probabilityLegendPattern = document.getElementById('probability-legend-pattern')!
  const gridThrowSection = document.getElementById('grid-throw-section')!
  const previewThrowSection = document.getElementById('preview-throw-section')!

  let rooms: RoomState[] = []
  let gridSide = 2
  let lastDiceCount = 6
  let screenMode: ScreenMode = 'sixes'
  let cameraView: CameraView = 'top'
  let gameMode = true
  let cameraAnimation: CameraAnimationState | null = null
  let isFocusedOnRoom = false
  let focusedRoomIndex: number | null = null
  const history: HistoryEntry[] = []

  const historyList = document.getElementById('history-list')!
  const historyStats = document.getElementById('history-stats')!
  const scoringList = document.getElementById('scoring-list')!
  const totalScoreEl = document.getElementById('total-score')!
  const fullscreenBalanceEl = document.getElementById('fullscreen-balance')!
  const fullscreenThrowListEl = document.getElementById('fullscreen-throw-list')!
  let totalScore = 0

  fetch('/api/balance', { credentials: 'include' })
    .then((r) => r.json())
    .then((d: { balance?: number }) => {
      const b = d.balance ?? 0
      totalScore = b
      totalScoreEl.textContent = String(b)
      if (gameMode) updateGameOverlay()
    })
    .catch(() => {})

  // Preview room: lazy-created when switching to preview, destroyed when returning to grid
  let previewPhysics: PhysicsState | null = null
  let previewGroup: THREE.Group | null = null
  let previewDiceMeshes: THREE.Object3D[] = []
  let previewLastThrow: ThrowRecord | null = null

  function ensurePreviewRoom() {
    const diceCount = getDiceCount()
    if (previewPhysics && previewGroup && previewPhysics.diceCount === diceCount) return
    destroyPreviewRoom()
    previewPhysics = createPhysicsWorld(getWeight(), getGravity(), diceCount)
    const created = createRoomVisuals(scene, -1, 0, 0, getGlossiness(), diceCount)
    previewGroup = created.group
    previewDiceMeshes = created.diceMeshes
  }

  function destroyPreviewRoom() {
    if (previewPhysics) {
      previewPhysics.world.free()
      previewPhysics = null
    }
    if (previewGroup) {
      scene.remove(previewGroup)
      previewGroup = null
    }
    previewDiceMeshes = []
  }

  function getGridSide(): number {
    return parseInt(gridSideSlider.value, 10) || 2
  }

  function getDiceCount(): number {
    const v = parseInt(diceCountSlider?.value ?? '6', 10)
    return Math.max(1, Math.min(50, v || 6))
  }

  function getMaxConcurrent(): number {
    const total = getGridSide() ** 2
    return Math.min(parseInt(maxConcurrentSlider.value, 10) || total, total)
  }

  function roomCenter(roomIndex: number): THREE.Vector3 {
    const side = getGridSide()
    const i = roomIndex % side
    const j = Math.floor(roomIndex / side)
    const extent = ((side - 1) * ROOM_SPACING) / 2
    return new THREE.Vector3(
      i * ROOM_SPACING - extent,
      0,
      j * ROOM_SPACING - extent
    )
  }

  function updateGameOverlay() {
    if (!gameMode) return
    fullscreenBalanceEl.textContent = String(totalScore)
  }

  const throwListObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) {
          const item = e.target as HTMLElement
          throwListObserver.unobserve(item)
          item.classList.add('fading')
          setTimeout(() => item.remove(), 500)
        }
      }
    },
    { root: fullscreenThrowListEl, rootMargin: '0px', threshold: 0 }
  )

  function addThrowListItem(entry: HistoryEntry) {
    if (!fullscreenThrowListEl) return
    const item = document.createElement('div')
    item.className = 'fullscreen-throw-item'
    const scoreStr = entry.escaped ? '+0' : `+${entry.score}`
    if (entry.escaped) {
      item.innerHTML = `<span class="fullscreen-throw-score escaped">${scoreStr}</span><span class="fullscreen-throw-badge escaped">escaped</span>`
    } else {
      const breakdown = computeScoreBreakdown(entry.diceResult)
      const comboSlug = (c: string) => c.toLowerCase().replace(/\s+/g, '-')
      const badgesHtml = breakdown.badges
        .map(
          (b) =>
            `<span class="fullscreen-throw-badge badge-combo-${comboSlug(b.combo)}">${b.combo} ${b.values.join(' ')} ${b.scoreDisplay}</span>`
        )
        .join('')
      item.innerHTML = `<span class="fullscreen-throw-score">${scoreStr}</span><div class="fullscreen-throw-badges">${badgesHtml}</div>`
    }
    fullscreenThrowListEl.prepend(item)
    void item.offsetHeight
    item.classList.add('visible')
    throwListObserver.observe(item)
  }

  const fullscreenBalanceWidget = document.getElementById('fullscreen-balance-widget')!
  const fullscreenThrowList = document.getElementById('fullscreen-throw-list')!
  const globalStatsPanel = document.getElementById('global-stats-panel')!
  const balanceToggleBtn = document.getElementById('balance-toggle-btn')!
  const statsToggleBtn = document.getElementById('stats-toggle-btn')!
  const mobileExpandBtn = document.getElementById('mobile-expand-btn')!

  const MOBILE_LAYOUT_KEY = 'dice-mobile-layout'
  type MobileLayoutState = { balance: 'full' | 'minimized' | 'hidden'; stats: 'full' | 'hidden' }

  function getMobileLayoutState(): MobileLayoutState {
    try {
      const s = localStorage.getItem(MOBILE_LAYOUT_KEY)
      if (s) {
        const parsed = JSON.parse(s) as MobileLayoutState
        if (parsed.balance && parsed.stats) return parsed
      }
    } catch (_) {}
    return { balance: 'full', stats: 'full' }
  }

  function setMobileLayoutState(state: MobileLayoutState) {
    try {
      localStorage.setItem(MOBILE_LAYOUT_KEY, JSON.stringify(state))
    } catch (_) {}
  }

  function applyMobileLayoutState(state: MobileLayoutState) {
    fullscreenBalanceWidget.dataset.mobileState = state.balance
    globalStatsPanel.dataset.mobileState = state.stats
    const collapsed = state.balance !== 'full' || state.stats !== 'full'
    const anyHidden = state.balance === 'hidden' || state.stats === 'hidden'
    canvasContainer.classList.toggle('mobile-ui-collapsed', collapsed)
    canvasContainer.classList.toggle('mobile-balance-hidden', state.balance === 'hidden')
    canvasContainer.classList.toggle('mobile-expand-visible', anyHidden)
    balanceToggleBtn.setAttribute('aria-label', state.balance === 'full' ? 'Minimize balance' : state.balance === 'minimized' ? 'Hide balance' : 'Show balance')
    balanceToggleBtn.setAttribute('title', state.balance === 'full' ? 'Minimize balance' : state.balance === 'minimized' ? 'Hide balance' : 'Show balance')
    balanceToggleBtn.textContent = state.balance === 'hidden' ? '+' : '−'
    statsToggleBtn.setAttribute('aria-label', state.stats === 'full' ? 'Hide stats' : 'Show stats')
    statsToggleBtn.setAttribute('title', state.stats === 'full' ? 'Hide stats' : 'Show stats')
    statsToggleBtn.textContent = state.stats === 'full' ? '−' : '+'
  }

  function initMobileLayout() {
    const state = getMobileLayoutState()
    applyMobileLayoutState(state)
  }

  balanceToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const state = getMobileLayoutState()
    if (state.balance === 'full') state.balance = 'minimized'
    else if (state.balance === 'minimized') state.balance = 'hidden'
    else state.balance = 'full'
    setMobileLayoutState(state)
    applyMobileLayoutState(state)
  })

  statsToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const state = getMobileLayoutState()
    state.stats = state.stats === 'full' ? 'hidden' : 'full'
    setMobileLayoutState(state)
    applyMobileLayoutState(state)
  })

  mobileExpandBtn.addEventListener('click', () => {
    const state: MobileLayoutState = { balance: 'full', stats: 'full' }
    setMobileLayoutState(state)
    applyMobileLayoutState(state)
  })

  function setGameMode(enabled: boolean) {
    gameMode = enabled
    app.classList.toggle('game-mode', gameMode)
    fullscreenBalanceWidget.ariaHidden = enabled ? 'false' : 'true'
    fullscreenThrowList.ariaHidden = enabled ? 'false' : 'true'
    globalStatsPanel.ariaHidden = enabled ? 'false' : 'true'
    if (gameMode) {
      setScreenMode('preview')
      updateGameOverlay()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => onResize(sceneState, container))
      })
    } else {
      setScreenMode('sixes')
      queueThrows()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => onResize(sceneState, container))
      })
    }
  }

  const sixesPanel = document.getElementById('sixes-panel')!
  const sixesList = document.getElementById('sixes-list')!

  function setScreenMode(mode: ScreenMode) {
    screenMode = mode
    tabSixes.classList.toggle('active', mode === 'sixes')
    tabGrid.classList.toggle('active', mode === 'grid')
    tabPreview.classList.toggle('active', mode === 'preview')
    tabProbability.classList.toggle('active', mode === 'probability')
    const showCanvas = mode === 'grid' || mode === 'preview'
    canvasContainer.style.display = showCanvas ? '' : 'none'
    sixesPanel.style.display = mode === 'sixes' ? 'flex' : 'none'
    probabilityPanel.style.display = mode === 'probability' ? 'flex' : 'none'

    if (mode === 'sixes') {
      destroyPreviewRoom()
      rooms.forEach(r => { r.group.visible = false })
      allRoomsBtn.style.display = 'none'
      backToGridBtn.style.display = 'none'
      gridThrowSection.style.display = 'none'
      previewThrowSection.style.display = 'none'
      renderSixesPanel()
    } else if (mode === 'grid') {
      destroyPreviewRoom()
      rooms.forEach(r => { r.group.visible = true })
      allRoomsBtn.style.display = ''
      backToGridBtn.style.display = 'none'
      gridThrowSection.style.display = ''
      previewThrowSection.style.display = 'none'
      const zoom = getGridZoom()
      const { position, target } = getCameraForAllRooms(getGridSide(), ROOM_SPACING, zoom, cameraView)
      camera.position.copy(position)
      controls.target.copy(target)
      isFocusedOnRoom = false
      focusedRoomIndex = null
    } else if (mode === 'preview') {
      ensurePreviewRoom()
      rooms.forEach(r => { r.group.visible = false })
      previewGroup!.visible = true
      allRoomsBtn.style.display = 'none'
      backToGridBtn.style.display = ''
      gridThrowSection.style.display = 'none'
      previewThrowSection.style.display = ''
      const cp = HARDCODED_DEFAULTS.cameraPosition
      const ct = HARDCODED_DEFAULTS.cameraTarget
      camera.position.set(cp.x, cp.y, cp.z)
      controls.target.set(ct.x, ct.y, ct.z)
      cameraAnimation = null
    } else if (mode === 'probability') {
      destroyPreviewRoom()
      rooms.forEach(r => { r.group.visible = false })
      allRoomsBtn.style.display = 'none'
      backToGridBtn.style.display = 'none'
      gridThrowSection.style.display = 'none'
      previewThrowSection.style.display = 'none'
      try {
        renderProbabilityChart()
      } catch (err) {
        console.error('renderProbabilityChart error:', err)
        probabilityChartSum.innerHTML = '<p style="color:#e74c3c">Error rendering chart</p>'
        probabilityChartPattern.innerHTML = ''
      }
    }
  }

  function renderSixesPanelWithData(sixes: Record<string, number>, totalThrows: number) {
    const total = totalThrows
    sixesList.innerHTML = ['6', '66', '666', '6666', '66666', '666666']
      .map((label) => {
        const count = sixes[label] ?? 0
        const pct = total > 0 ? ((count / total) * 100).toFixed(2) : '0'
        return `
          <div class="sixes-row">
            <span class="sixes-label">${label}</span>
            <span class="sixes-count">${count.toLocaleString()}</span>
            <span class="sixes-pct">${pct}%</span>
          </div>
        `
      })
      .join('')
  }

  function renderSixesPanel() {
    fetch('/api/stats', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { sixes?: Record<string, number>; totalThrows?: number }) => {
        const sixes = d.sixes ?? { '6': 0, '66': 0, '666': 0, '6666': 0, '66666': 0, '666666': 0 }
        renderSixesPanelWithData(sixes, d.totalThrows ?? 0)
      })
      .catch(() => { sixesList.innerHTML = '<p style="color:rgba(255,255,255,0.5)">Failed to load</p>' })
  }

  const simulateCountInput = document.getElementById('simulate-count') as HTMLInputElement | null
  const simulateSendApiCheck = document.getElementById('simulate-send-api') as HTMLInputElement | null
  const simulateBtn = document.getElementById('simulate-btn') as HTMLButtonElement | null
  const simulateStatus = document.getElementById('simulate-status')!

  simulateBtn?.addEventListener('click', async () => {
    const n = Math.min(10000, Math.max(10, parseInt(simulateCountInput?.value ?? '1000', 10) || 1000))
    const sendToApi = simulateSendApiCheck?.checked ?? true
    if (simulateBtn) simulateBtn.disabled = true
    simulateStatus.textContent = `Running ${n} throws...`

    const sixes: Record<string, number> = { '6': 0, '66': 0, '666': 0, '6666': 0, '66666': 0, '666666': 0 }
    let totalThrows = 0
    const throws: { diceResult: number[]; escaped: boolean; combos: string[]; score: number; balance: number }[] = []
    let runningBalance = totalScore

    for (let i = 0; i < n; i++) {
      const diceResult = Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1)
      const escaped = false
      const breakdown = computeScoreBreakdown(diceResult)
      const pattern = getRarityPattern(diceResult)
      const allCombos: string[] = []
      for (const b of breakdown.badges) allCombos.push(b.combo)
      if (pattern && !allCombos.includes(pattern.name)) allCombos.push(pattern.name)
      const score = computeScore(diceResult)
      runningBalance += score

      totalThrows++
      const sixCount = diceResult.filter((v) => v === 6).length
      if (sixCount >= 1 && sixCount <= 6) sixes[String(6).repeat(sixCount)]++

      if (sendToApi) {
        throws.push({ diceResult, escaped, combos: allCombos, score, balance: runningBalance })
      }
    }

    if (sendToApi && throws.length > 0) {
      const BATCH = 100
      for (let i = 0; i < throws.length; i += BATCH) {
        const batch = throws.slice(i, i + BATCH)
        simulateStatus.textContent = `Sending ${Math.min(i + BATCH, throws.length)}/${throws.length}...`
        await fetch('/api/record-throws', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ throws: batch })
        })
      }
      totalScore = runningBalance
      totalScoreEl.textContent = String(totalScore)
      if (gameMode) updateGameOverlay()
      fetchGlobalStats()
    } else {
      renderSixesPanelWithData(sixes, totalThrows)
      simulateStatus.textContent = `Done. ${n} throws (local only)`
    }

    if (simulateBtn) simulateBtn.disabled = false
    if (sendToApi) simulateStatus.textContent = `Done. ${n} throws sent to API.`
  })

  function buildRooms() {
    const newGridSide = getGridSide()
    const newDiceCount = getDiceCount()
    if (newGridSide === gridSide && newDiceCount === lastDiceCount && rooms.length === newGridSide ** 2) return
    gridSide = newGridSide
    lastDiceCount = newDiceCount

    for (const r of rooms) {
      scene.remove(r.group)
      r.physics.world.free()
    }
    rooms = []

    const total = gridSide ** 2
    const extent = ((gridSide - 1) * ROOM_SPACING) / 2

    for (let idx = 0; idx < total; idx++) {
      const i = idx % gridSide
      const j = Math.floor(idx / gridSide)
      const offsetX = i * ROOM_SPACING - extent
      const offsetZ = j * ROOM_SPACING - extent

      const physics = createPhysicsWorld(getWeight(), getGravity(), newDiceCount)
      const { group, diceMeshes } = createRoomVisuals(scene, idx, offsetX, offsetZ, getGlossiness(), newDiceCount)

      rooms.push({
        physics,
        diceMeshes,
        group,
        roomIndex: idx,
        lastThrow: null,
        hasRecordedThisThrow: false,
        settledFrameCount: 0,
        lastThrowTime: performance.now()
      })
    }

    maxConcurrentSlider.max = String(total)
    if (parseInt(maxConcurrentSlider.value, 10) > total) {
      maxConcurrentSlider.value = String(total)
      maxConcurrentValueEl.textContent = String(total)
    }
    updateMaxConcurrentLabel()

    const zoom = parseFloat(gridZoomSlider?.value ?? '1') || 1
    const { position, target } = getCameraForAllRooms(gridSide, ROOM_SPACING, zoom, cameraView)
    camera.position.copy(position)
    controls.target.copy(target)
    isFocusedOnRoom = false
    focusedRoomIndex = null
  }

  function getGridZoom(): number {
    return parseFloat(gridZoomSlider?.value ?? '1') || 1
  }

  function updateMaxConcurrentLabel() {
    maxConcurrentValueEl.textContent = maxConcurrentSlider.value
  }

  const TOTAL_OUTCOMES = 6 ** 6

  type RarityPattern = { id: string; name: string; count: number; desc: string }

  /** Rarity patterns for 6 dice. Count = number of outcomes matching this pattern. */
  const RARITY_PATTERNS: RarityPattern[] = (() => {
    const fact = (n: number) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r }
    const perm = (counts: number[]) => fact(6) / counts.reduce((p, c) => p * fact(c), 1)
    const groupSymmetry = (sig: number[]) => {
      const freq: Record<number, number> = {}
      for (const s of sig) freq[s] = (freq[s] ?? 0) + 1
      return Object.values(freq).reduce((p, f) => p * fact(f), 1)
    }

    const patterns: { sig: number[]; name: string; desc: string }[] = [
      { sig: [6], name: 'Six of a kind', desc: 'All same' },
      { sig: [5, 1], name: 'Five of a kind', desc: '5 same + 1 different' },
      { sig: [4, 2], name: 'Four + pair', desc: '4 same + 2 same' },
      { sig: [4, 1, 1], name: 'Four of a kind', desc: '4 same + 2 different' },
      { sig: [3, 2, 1], name: 'Three + pair', desc: '3 same + 2 same + 1' },
      { sig: [3, 1, 1, 1], name: 'Three of a kind', desc: '3 same + 3 different' },
      { sig: [2, 2, 2], name: 'Three pairs', desc: '2-2-2 of three values' },
      { sig: [2, 2, 1, 1], name: 'Two pairs', desc: '2 pairs + 2 singletons' },
      { sig: [1, 1, 1, 1, 1, 1], name: 'Large straight', desc: 'All different (1-6)' }
    ]

    const result = patterns.map(({ sig, name, desc }) => {
      const k = sig.length
      const valueChoices = fact(6) / fact(6 - k) / groupSymmetry(sig)
      const arrangements = perm(sig)
      const count = Math.round(valueChoices * arrangements)
      return { id: sig.join('-'), name, count, desc }
    })
    result.push({ id: 'small-straight', name: 'Small straight', count: 3600, desc: '5 consecutive (1-5 or 2-6)' })
    return result
  })()

  /** Classify dice result into a rarity pattern. */
  function getRarityPattern(diceResult: number[]): RarityPattern | null {
    if (diceResult.length !== 6) return null
    const counts = [0, 0, 0, 0, 0, 0]
    for (const v of diceResult) {
      if (v >= 1 && v <= 6) counts[v - 1]++
    }
    const sig = counts.filter(c => c > 0).sort((a, b) => b - a)
    const sigStr = sig.join('-')
    if (sigStr === '2-1-1-1-1') {
      const vals = [1, 2, 3, 4, 5, 6].filter((v) => counts[v - 1] >= 1)
      const has12345 = [1, 2, 3, 4, 5].every((d) => vals.includes(d))
      const has23456 = [2, 3, 4, 5, 6].every((d) => vals.includes(d))
      if (has12345 || has23456) return RARITY_PATTERNS.find((p) => p.id === 'small-straight') ?? null
      return null
    }
    return RARITY_PATTERNS.find((p) => p.id === sigStr) ?? null
  }

  /** Count distinct sequences for this multiset. Rarity = 1 in (TOTAL_OUTCOMES / count). */
  function getRarity(diceResult: number[]): number {
    if (diceResult.length === 0) return 0
    const counts = [0, 0, 0, 0, 0, 0]
    for (const v of diceResult) {
      if (v >= 1 && v <= 6) counts[v - 1]++
    }
    let permutations = 1
    for (let i = 2; i <= 6; i++) permutations *= i
    for (const c of counts) {
      for (let i = 2; i <= c; i++) permutations /= i
    }
    return Math.round(TOTAL_OUTCOMES / permutations)
  }

  function formatRarity(rarity: number): string {
    if (rarity >= 1_000_000) return (rarity / 1_000_000).toFixed(1) + 'M'
    if (rarity >= 1_000) return (rarity / 1_000).toFixed(1) + 'k'
    return String(rarity)
  }

  /** Compute count of ways to get each sum (6–36) with 6 dice. */
  function getSumDistribution(): { sum: number; count: number; prob: number }[] {
    const dp: number[][] = Array.from({ length: 37 }, () => Array(7).fill(0))
    for (let s = 1; s <= 6; s++) dp[s][1] = 1
    for (let n = 2; n <= 6; n++) {
      for (let s = n; s <= 6 * n; s++) {
        for (let k = 1; k <= 6 && s - k >= n - 1; k++) {
          dp[s][n] += dp[s - k][n - 1]
        }
      }
    }
    const out: { sum: number; count: number; prob: number }[] = []
    for (let s = 6; s <= 36; s++) {
      const count = dp[s][6]
      out.push({ sum: s, count, prob: count / TOTAL_OUTCOMES })
    }
    return out
  }

  let patternFilter: string | null = null
  let cachedComboLeaders: Record<string, { name: string; count: number }> = {}

  function applyHistoryFilter() {
    historyList.querySelectorAll('.history-entry').forEach((el) => {
      const pattern = (el as HTMLElement).dataset.pattern ?? ''
      const visible = !patternFilter || pattern === patternFilter
      ;(el as HTMLElement).style.display = visible ? '' : 'none'
    })
  }

  function renderProbabilityChart() {
    const chartW = 400
    const chartH = 180
    const pad = { t: 20, r: 20, b: 40, l: 80 }
    const plotW = chartW - pad.l - pad.r
    const plotH = chartH - pad.t - pad.b
    const recorded = history.filter(h => !h.escaped && h.diceResult.length === 6)
    const total = recorded.length

    // Sum chart
    const dist = getSumDistribution()
    const observedSum: Record<number, number> = {}
    for (let s = 6; s <= 36; s++) observedSum[s] = 0
    for (const h of recorded) {
      const sum = h.diceResult.reduce((a, b) => a + b, 0)
      observedSum[sum]++
    }
    const simProbs: Record<number, number> = {}
    for (let s = 6; s <= 36; s++) simProbs[s] = total > 0 ? observedSum[s] / total : 0

    const maxTheoSum = Math.max(...dist.map(d => d.prob))
    const maxSimSum = total > 0 ? Math.max(...Object.values(simProbs)) : 0
    const maxProb = Math.max(maxTheoSum, maxSimSum || 0, 1e-10)
    const barW = plotW / dist.length - 2

    let svgSum = `<svg width="${chartW}" height="${chartH}" viewBox="0 0 ${chartW} ${chartH}">`
    dist.forEach((d, i) => {
      const x = pad.l + i * (barW + 2)
      const hTheo = (d.prob / maxProb) * plotH
      const hSim = total > 0 ? (simProbs[d.sum] / maxProb) * plotH : 0
      const yTheo = pad.t + plotH - hTheo
      const ySim = pad.t + plotH - hSim
      const pctTheo = (d.prob * 100).toFixed(2)
      const pctSim = total > 0 ? (simProbs[d.sum] * 100).toFixed(2) : '0'
      svgSum += `<rect x="${x}" y="${yTheo}" width="${barW}" height="${hTheo}" fill="#4ecdc4" opacity="0.7" rx="2"/>`
      if (total > 0 && hSim > 0) {
        svgSum += `<rect x="${x}" y="${ySim}" width="${barW}" height="${hSim}" fill="#e74c3c" opacity="0.9" rx="2"/>`
      }
      svgSum += `<text x="${x + barW / 2}" y="${chartH - 8}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.7)">${d.sum}</text>`
      if (hTheo > 18) svgSum += `<text x="${x + barW / 2}" y="${yTheo + hTheo / 2 + 4}" text-anchor="middle" font-size="8" fill="#1a1a2e">${pctTheo}%</text>`
      if (total > 0 && hSim > 14 && Math.abs(hSim - hTheo) > 4) svgSum += `<text x="${x + barW / 2}" y="${ySim + hSim / 2 + 3}" text-anchor="middle" font-size="8" fill="#fff">${pctSim}%</text>`
    })
    svgSum += '</svg>'
    probabilityChartSum.innerHTML = svgSum

    const obsStrSum = Object.entries(observedSum)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${s}: ${n}`)
      .join(' · ')
    probabilityLegendSum.textContent = recorded.length > 0
      ? `Observed (${recorded.length}): ${obsStrSum || '—'} · Teal = theoretical, Red = simulation`
      : 'Throw dice to see observed distribution.'

    // Rarity patterns chart
    const observed: Record<string, number> = {}
    for (const p of RARITY_PATTERNS) observed[p.name] = 0
    for (const h of recorded) {
      const pat = getRarityPattern(h.diceResult)
      if (pat) observed[pat.name]++
    }

    const maxCount = Math.max(...RARITY_PATTERNS.map(p => p.count))
    const maxTheo = maxCount / TOTAL_OUTCOMES
    const maxSim = total > 0 ? Math.max(...RARITY_PATTERNS.map(p => observed[p.name] / total)) : 0
    const scaleMax = Math.max(maxTheo, maxSim || 0, 1e-10)

    const barH = 12
    const gap = 3
    const totalH = RARITY_PATTERNS.length * (barH + gap) - gap

    let svgPattern = `<svg width="${chartW}" height="${Math.max(chartH, totalH + pad.t + pad.b)}" viewBox="0 0 ${chartW} ${Math.max(chartH, totalH + pad.t + pad.b)}" class="pattern-chart-svg">`
    RARITY_PATTERNS.forEach((p, i) => {
      const y = pad.t + i * (barH + gap)
      const theoProb = p.count / TOTAL_OUTCOMES
      const simProb = total > 0 ? observed[p.name] / total : 0
      const wTheo = (theoProb / scaleMax) * plotW
      const wSim = (simProb / scaleMax) * plotW
      const pctTheo = (theoProb * 100).toFixed(2)
      const pctSim = total > 0 ? (simProb * 100).toFixed(2) : '0'
      const rarity = Math.round(TOTAL_OUTCOMES / p.count)
      const isActive = patternFilter === p.name
      const leader = cachedComboLeaders[p.name]
      const leaderTitle = leader ? `Most: ${leader.name} (${leader.count.toLocaleString()} throws)` : ''
      svgPattern += `<g class="pattern-bar" data-pattern="${p.name}" style="cursor:pointer">`
      if (leaderTitle) svgPattern += `<title>${escapeHtml(leaderTitle)}</title>`
      svgPattern += `<rect x="${pad.l}" y="${y}" width="${plotW}" height="${barH}" fill="transparent"/>`
      svgPattern += `<rect x="${pad.l}" y="${y}" width="${wTheo}" height="${barH}" fill="#9b59b6" opacity="${isActive ? 1 : 0.7}" rx="2"/>`
      if (total > 0 && wSim > 0) {
        svgPattern += `<rect x="${pad.l}" y="${y}" width="${wSim}" height="${barH}" fill="#e74c3c" opacity="0.9" rx="2"/>`
      }
      const labelX = pad.l + Math.max(wTheo, wSim) + 6
      const labelText = total > 0
        ? `th: ${pctTheo}% · sim: ${pctSim}% · 1 in ${formatRarity(rarity)}`
        : `${pctTheo}% · 1 in ${formatRarity(rarity)}`
      svgPattern += `<text x="${pad.l - 6}" y="${y + barH - 2}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.8)">${p.name}</text>`
      svgPattern += `<text x="${labelX}" y="${y + barH - 2}" text-anchor="start" font-size="8" fill="rgba(255,255,255,0.6)">${labelText}</text>`
      svgPattern += `</g>`
    })
    svgPattern += '</svg>'
    probabilityChartPattern.innerHTML = svgPattern

    probabilityChartPattern.querySelectorAll('.pattern-bar').forEach((g) => {
      g.addEventListener('click', () => {
        const name = (g as HTMLElement).dataset.pattern ?? ''
        patternFilter = patternFilter === name ? null : name
        renderProbabilityChart()
        applyHistoryFilter()
      })
    })

    const obsStr = Object.entries(observed)
      .filter(([, n]) => n > 0)
      .map(([n, c]) => `${n}: ${c}`)
      .join(' · ')
    let legendText = recorded.length > 0
      ? `Observed: ${obsStr || '—'} · Purple = theoretical, Red = simulation`
      : 'Throw dice to see observed patterns.'
    if (patternFilter) {
      const matchCount = recorded.filter(h => getRarityPattern(h.diceResult)?.name === patternFilter).length
      legendText += ` · Filter: ${patternFilter} (${matchCount}) · click bar again to clear`
    }
    probabilityLegendPattern.textContent = legendText
  }

  function updateHistoryStats() {
    const total = history.length
    const escaped = history.filter(h => h.escaped).length
    historyStats.textContent = `${total - escaped}/${total}`
  }

  const PRESETS: PatternPreset[] = ['stack', 'scatter', 'ring', 'line']

  function showNotification(message: string, type: 'pattern' | 'info' = 'pattern', opts?: { patternName: string; entry: HistoryEntry }) {
    const container = document.getElementById('notification-container')!
    const el = document.createElement('div')
    el.className = `notification-toast notification-toast-${type}`
    el.textContent = message
    if (opts) {
      el.classList.add('notification-toast-clickable')
      el.addEventListener('click', () => {
        patternFilter = opts.patternName
        applyHistoryFilter()
        renderProbabilityChart()
        setScreenMode('preview')
        replayFromHistory(opts.entry)
      })
    }
    container.appendChild(el)
    el.offsetHeight
    el.classList.add('visible')
    setTimeout(() => {
      el.classList.remove('visible')
      setTimeout(() => el.remove(), 300)
    }, 2500)
  }

  function showAchievementNotification(achievementName: string) {
    const container = document.getElementById('notification-container')!
    const el = document.createElement('div')
    el.className = 'notification-toast notification-toast-achievement'
    el.innerHTML = `<span class="achievement-notification-icon">✓</span> ${achievementName}`
    container.appendChild(el)
    el.offsetHeight
    el.classList.add('visible')
    setTimeout(() => {
      el.classList.remove('visible')
      setTimeout(() => el.remove(), 300)
    }, 2000)
  }

  function addHistoryEntry(entry: HistoryEntry) {
    history.push(entry)
    totalScore += entry.score
    totalScoreEl.textContent = String(totalScore)
    const scoringRow = document.createElement('div')
    if (entry.escaped) {
      scoringRow.className = 'scoring-entry'
      scoringRow.innerHTML = `<span class="scoring-badge scoring-badge-escaped">escaped <span class="scoring-badge-score">+0</span></span>`
    } else {
      const breakdown = computeScoreBreakdown(entry.diceResult)
      scoringRow.className = 'scoring-entry'
      const comboSlug = (c: string) => c.toLowerCase().replace(/\s+/g, '-')
      const badgesHtml = breakdown.badges
        .map(
          (b) =>
            `<span class="scoring-badge badge-combo-${comboSlug(b.combo)}" title="${b.combo}">${b.combo} <span class="scoring-badge-values">${b.values.join(' ')}</span><span class="scoring-badge-score">${b.scoreDisplay}</span></span>`
        )
        .join('')
      scoringRow.innerHTML = `
        <div class="scoring-badges">${badgesHtml}</div>
      `
    }
    if (document.fullscreenElement || gameMode) {
      updateGameOverlay()
      addThrowListItem(entry)
    }
    scoringList.prepend(scoringRow)
    const pattern = entry.escaped ? null : getRarityPattern(entry.diceResult)
    if (!entry.escaped && entry.diceResult.length === 6) {
      const toClaim = getAchievementsToClaim(entry.diceResult)
      const newlyClaimed = claimAchievements(toClaim)
      if (newlyClaimed.length > 0) {
        showAchievementNotification(getAchievementDisplayName(newlyClaimed[0]))
      }
    }
    updateHistoryStats()

    updateLocalStats(entry)
    if (isLocalBuild) applyLocalStats()

    // Report to global analytics (Vercel + shared stats)
    const allCombos: string[] = []
    if (!entry.escaped && entry.diceResult.length > 0) {
      const breakdown = computeScoreBreakdown(entry.diceResult)
      for (const b of breakdown.badges) allCombos.push(b.combo)
      if (pattern && !allCombos.includes(pattern.name)) allCombos.push(pattern.name)
    }
    const comboName = pattern?.name ?? null
    track('Dice Throw', { escaped: !!entry.escaped, combo: comboName ?? 'none', score: entry.score })
    fetch('/api/record-throw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        diceResult: entry.diceResult,
        escaped: entry.escaped,
        combos: allCombos,
        balance: totalScore,
        score: entry.score,
        time: entry.time,
        seed: entry.seed,
        weight: entry.weight,
        gravity: entry.gravity,
        options: entry.options
      })
    })
      .then((r) => r.json())
      .then((d: { stored?: boolean }) => { if (d.stored) fetchGlobalStats() })
      .catch(() => {})

    const idx = history.length
    const timeStr = new Date(entry.time).toLocaleTimeString()
    const roomBadge = `<span class="history-room">#${entry.roomIndex + 1}</span>`
    const resultStr = entry.escaped ? '—' : entry.diceResult.join(' ')
    const rarity = entry.escaped ? 0 : getRarity(entry.diceResult)
    const rarityStr = rarity > 0 ? `1 in ${formatRarity(rarity)}` : ''
    const badges = []
    if (entry.escaped) badges.push('<span class="history-badge history-badge-escaped">escaped</span>')
    else {
      badges.push(`<span class="history-badge history-badge-result">${resultStr}</span>`)
      if (pattern) badges.push(`<span class="history-badge history-badge-pattern" title="${pattern.desc}">${pattern.name}</span>`)
      if (rarityStr) badges.push(`<span class="history-badge history-badge-rarity">${rarityStr}</span>`)
    }
    const el = document.createElement('div')
    el.dataset.pattern = pattern?.name ?? ''
    el.className = `history-entry${entry.escaped ? ' is-escaped' : ''}`
    el.innerHTML = `<span class="history-dot ${entry.escaped ? 'escaped' : 'ok'}"></span><span class="history-index">${idx}</span>${roomBadge}<span class="history-time">${timeStr}</span>${badges.join('')}<button class="history-replay-btn">▶</button>`
    el.querySelector('.history-replay-btn')!.addEventListener('click', (e) => {
      e.stopPropagation()
      replayFromHistory(entry)
    })
    el.addEventListener('click', () => replayFromHistory(entry))
    historyList.prepend(el)
    applyHistoryFilter()
    if (screenMode === 'probability') renderProbabilityChart()
  }

  function replayFromHistory(entry: HistoryEntry) {
    setScreenMode('preview')
    ensurePreviewRoom()
    clearDiceComboVFX(previewDiceMeshes)
    previewLastThrow = null
    gravitySlider.value = String(entry.gravity)
    gravityValue.textContent = String(entry.gravity)
    weightSlider.value = String(entry.weight)
    weightValue.textContent = String(entry.weight)
    previewPhysics!.currentMass = entry.weight
    previewPhysics!.currentGravity = entry.gravity
    setGravity(previewPhysics!, entry.gravity)
    throwDice(previewPhysics!, { ...entry.options, seed: entry.seed })
  }

  document.getElementById('clear-history-btn')!.addEventListener('click', () => {
    history.length = 0
    historyList.innerHTML = ''
    totalScore = 0
    totalScoreEl.textContent = '0'
    scoringList.innerHTML = ''
    fullscreenThrowListEl.innerHTML = ''
    updateGameOverlay()
    updateHistoryStats()
    localStats.totalThrows = 0
    localStats.sixes = { '6': 0, '66': 0, '666': 0, '6666': 0, '66666': 0, '666666': 0 }
    localStats.combos = {}
    if (isLocalBuild) applyLocalStats()
    fetch('/api/balance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ balance: 0 })
    }).catch(() => {})
  })

  const achievementsModal = document.getElementById('achievements-modal')!
  const achievementsGrid = document.getElementById('achievements-grid')!
  const achievementsCountEl = document.getElementById('achievements-count')!
  const achievementsCloseBtn = document.getElementById('achievements-close')!

  function runRetroactiveAchievements() {
    for (const entry of history) {
      if (!entry.escaped && entry.diceResult.length === 6) {
        claimAchievements(getAchievementsToClaim(entry.diceResult))
      }
    }
  }

  function renderAchievementsGrid() {
    runRetroactiveAchievements()
    const claimed = loadClaimedAchievements()
    achievementsCountEl.textContent = `${claimed.size}/${TOTAL_ACHIEVEMENTS}`
    const groups = getAchievementsGroupedByRarity()
    achievementsGrid.innerHTML = groups
      .map(({ groupName, ids }) => {
        const cells = ids
          .map((id) => {
            const isClaimed = claimed.has(id)
            const name = getAchievementDisplayName(id)
            const icon = isClaimed ? '✓' : '?'
            return `<div class="achievement-cell ${isClaimed ? 'claimed' : 'locked'}" data-id="${escapeHtml(id)}" data-tooltip="${escapeHtml(name)}">${icon}</div>`
          })
          .join('')
        return `<div class="achievement-group"><h5 class="achievement-group-title">${escapeHtml(groupName)}</h5><div class="achievement-group-grid">${cells}</div></div>`
      })
      .join('')
  }

  function openAchievementsModal() {
    renderAchievementsGrid()
    achievementsModal.classList.add('visible')
    achievementsModal.ariaHidden = 'false'
  }

  function closeAchievementsModal() {
    achievementsModal.classList.remove('visible')
    achievementsModal.ariaHidden = 'true'
  }

  document.getElementById('achievements-btn')!.addEventListener('click', openAchievementsModal)
  achievementsCloseBtn.addEventListener('click', closeAchievementsModal)
  achievementsModal.addEventListener('click', (e) => {
    if (e.target === achievementsModal) closeAchievementsModal()
  })

  const globalStatsEl = document.getElementById('global-stats-text')!
  const globalStatsTotalEl = document.getElementById('global-stats-total')!
  const globalStatsLeaderboardEl = document.getElementById('global-stats-leaderboard')!
  const globalStatsSixesEl = document.getElementById('global-stats-sixes')!
  const globalStatsCombosEl = document.getElementById('global-stats-combos')!
  const userNameInput = document.getElementById('user-name-input') as HTMLInputElement | null
  const userNameSaveBtn = document.getElementById('user-name-save') as HTMLButtonElement | null

  const isLocalBuild = typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  const localStats = {
    totalThrows: 0,
    sixes: { '6': 0, '66': 0, '666': 0, '6666': 0, '66666': 0, '666666': 0 } as Record<string, number>,
    combos: {} as Record<string, number>
  }

  function updateLocalStats(entry: HistoryEntry) {
    localStats.totalThrows++
    if (!entry.escaped && entry.diceResult.length > 0) {
      const sixCount = entry.diceResult.filter((v) => v === 6).length
      if (sixCount >= 1 && sixCount <= 6) {
        const key = String(6).repeat(sixCount)
        localStats.sixes[key] = (localStats.sixes[key] ?? 0) + 1
      }
      const breakdown = computeScoreBreakdown(entry.diceResult)
      const pattern = getRarityPattern(entry.diceResult)
      for (const b of breakdown.badges) {
        localStats.combos[b.combo] = (localStats.combos[b.combo] ?? 0) + 1
      }
      if (pattern) localStats.combos[pattern.name] = (localStats.combos[pattern.name] ?? 0) + 1
    }
  }

  function applyLocalStats() {
    const { totalThrows, sixes, combos } = localStats
    const uniqueCombos = Object.keys(combos).length
    globalStatsEl.textContent = `${totalThrows.toLocaleString()} throws · ${uniqueCombos} combos`
    globalStatsTotalEl.textContent = `${totalThrows.toLocaleString()} throws`
    renderGlobalStatsSixes(sixes, totalThrows)
    renderGlobalStatsPanel(totalThrows, combos)
    renderSixesPanelWithData(sixes, totalThrows)
  }

  function renderGlobalStatsLeaderboard(leaderboard: { rank: number; name: string; throws: number }[]) {
    if (leaderboard.length === 0) {
      globalStatsLeaderboardEl.innerHTML = '<span style="color:rgba(255,255,255,0.4);font-size:11px">No data yet</span>'
      return
    }
    globalStatsLeaderboardEl.innerHTML = leaderboard
      .map(
        (e) =>
          `<div class="global-stats-leaderboard-row"><span class="global-stats-leaderboard-rank">${e.rank}</span><span class="global-stats-leaderboard-name">${escapeHtml(e.name)}</span><span class="global-stats-leaderboard-throws">${e.throws.toLocaleString()}</span></div>`
      )
      .join('')
  }

  function escapeHtml(s: string): string {
    const div = document.createElement('div')
    div.textContent = s
    return div.innerHTML
  }

  function fetchLeaderboard() {
    if (isLocalBuild) return
    fetch('/api/leaderboard?limit=10', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { leaderboard?: { rank: number; name: string; throws: number }[] }) => {
        renderGlobalStatsLeaderboard(d.leaderboard ?? [])
      })
      .catch(() => { globalStatsLeaderboardEl.innerHTML = '' })
  }

  function fetchUserName() {
    if (isLocalBuild || !userNameInput) return
    fetch('/api/name', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { name?: string; display?: string }) => {
        if (userNameInput) userNameInput.value = d.name ?? ''
      })
      .catch(() => {})
  }

  function saveUserName() {
    if (isLocalBuild || !userNameInput || !userNameSaveBtn) return
    const name = userNameInput.value.trim().slice(0, 32)
    userNameSaveBtn.disabled = true
    fetch('/api/name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name })
    })
      .then(() => { userNameSaveBtn!.disabled = false })
      .catch(() => { userNameSaveBtn!.disabled = false })
  }

  userNameSaveBtn?.addEventListener('click', saveUserName)

  function renderGlobalStatsSixes(sixes: Record<string, number>, totalThrows: number) {
    const labels = ['6', '66', '666', '6666', '66666', '666666']
    const total = totalThrows
    globalStatsSixesEl.innerHTML = labels
      .map((label) => {
        const count = sixes[label] ?? 0
        const pct = total > 0 ? ((count / total) * 100).toFixed(2) : '0'
        return `<div class="global-stats-sixes-row"><span class="global-stats-sixes-label">${label}</span><span class="global-stats-sixes-count">${count.toLocaleString()}</span><span class="global-stats-sixes-pct">${pct}%</span></div>`
      })
      .join('')
  }

  const renderGlobalStatsPanel = (totalThrows: number, combos: Record<string, number>, comboLeaders?: Record<string, { name: string; count: number }>) => {
    globalStatsTotalEl.textContent = `${totalThrows.toLocaleString()} throws`
    if (totalThrows === 0) {
      globalStatsCombosEl.innerHTML = '<span style="color:rgba(255,255,255,0.4);font-size:12px">No data yet</span>'
      return
    }
    const sorted = [...RARITY_PATTERNS].sort((a, b) => b.count - a.count) // common → rare
    const maxVal = Math.max(
      ...sorted.map((p) => Math.max(combos[p.name] ?? 0, (p.count / TOTAL_OUTCOMES) * totalThrows)),
      1
    )
    globalStatsCombosEl.innerHTML = sorted.map((p) => {
      const observed = combos[p.name] ?? 0
      const expected = (p.count / TOTAL_OUTCOMES) * totalThrows
      const observedPct = (observed / maxVal) * 100
      const expectedPct = (expected / maxVal) * 100
      const observedPctReal = totalThrows > 0 ? (observed / totalThrows) * 100 : 0
      const expectedPctReal = (p.count / TOTAL_OUTCOMES) * 100
      const leader = comboLeaders?.[p.name]
      const tooltip = leader
        ? `Most: ${leader.name} (${leader.count.toLocaleString()} throws)`
        : observed > 0
          ? `${p.name}: ${observed.toLocaleString()} observed`
          : ''
      return `
        <div class="global-stats-row" ${tooltip ? `data-tooltip="${escapeHtml(tooltip)}"` : ''}>
          <div class="global-stats-row-header">
            <span class="global-stats-row-name">${p.name}</span>
            <span class="global-stats-row-counts">${observed} (${observedPctReal.toFixed(2)}%) · exp ${expectedPctReal.toFixed(2)}%</span>
          </div>
          <div class="global-stats-bar-track">
            <div class="global-stats-bar-expected" style="width:${expectedPct}%"></div>
            <div class="global-stats-bar-observed" style="width:${observedPct}%"></div>
          </div>
        </div>
      `
    }).join('')
  }

  const fetchGlobalStats = () => {
    fetch('/api/stats', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { totalThrows?: number; uniqueCombos?: number; combos?: Record<string, number>; sixes?: Record<string, number>; comboLeaders?: Record<string, { name: string; count: number }> }) => {
        const total = isLocalBuild && localStats.totalThrows > 0 ? localStats.totalThrows : (d.totalThrows ?? 0)
        const comboCounts = isLocalBuild && localStats.totalThrows > 0 ? localStats.combos : (d.combos ?? {})
        const sixes = isLocalBuild && localStats.totalThrows > 0 ? localStats.sixes : (d.sixes ?? { '6': 0, '66': 0, '666': 0, '6666': 0, '66666': 0, '666666': 0 })
        const uniqueCombos = Object.keys(comboCounts).length
        const comboLeaders = d.comboLeaders ?? {}
        cachedComboLeaders = comboLeaders
        globalStatsEl.textContent = `${total.toLocaleString()} throws · ${uniqueCombos} combos`
        renderGlobalStatsSixes(sixes, total)
        renderGlobalStatsPanel(total, comboCounts, comboLeaders)
        fetchLeaderboard()
        if (screenMode === 'sixes') renderSixesPanel()
        if (screenMode === 'probability') renderProbabilityChart()
      })
      .catch(() => {
        if (localStats.totalThrows > 0) applyLocalStats()
        else {
          globalStatsEl.textContent = '— throws · — combos'
          globalStatsTotalEl.textContent = '—'
          globalStatsLeaderboardEl.innerHTML = ''
          globalStatsSixesEl.innerHTML = ''
          globalStatsCombosEl.innerHTML = ''
        }
      })
  }
  fetchUserName()
  fetchGlobalStats()
  fetchLeaderboard()
  setInterval(fetchGlobalStats, 30_000)
  setInterval(fetchLeaderboard, 30_000)
  if (isLocalBuild) applyLocalStats()

  const powerSlider = document.getElementById('throw-power') as HTMLInputElement
  const powerValue = document.getElementById('power-value')!
  const directionSpreadSlider = document.getElementById('direction-spread') as HTMLInputElement
  const directionSpreadValue = document.getElementById('direction-spread-value')!
  const speedVariationSlider = document.getElementById('speed-variation') as HTMLInputElement
  const speedVariationValue = document.getElementById('speed-variation-value')!
  const rotationSlider = document.getElementById('rotation') as HTMLInputElement
  const rotationValue = document.getElementById('rotation-value')!
  const aimEdgeCheckbox = document.getElementById('aim-edge') as HTMLInputElement
  const autoLoopCheckbox = document.getElementById('auto-loop') as HTMLInputElement

  const spawnLayoutSelect = document.getElementById('spawn-layout') as HTMLSelectElement | null
  const targetModeSelect = document.getElementById('target-mode') as HTMLSelectElement | null
  const patternPresetSelect = document.getElementById('pattern-preset') as HTMLSelectElement | null
  const randomPresetCheckbox = document.getElementById('random-preset') as HTMLInputElement | null

  const getThrowOptions = (opts?: { seed?: number }): ThrowOptions => {
    const basePreset = (patternPresetSelect?.value as PatternPreset) ?? 'none'
    const useRandomPreset = randomPresetCheckbox?.checked ?? false
    const patternPreset: PatternPreset = useRandomPreset
      ? PRESETS[Math.floor((opts?.seed ?? Math.random() * 0xffffffff) % PRESETS.length)]
      : basePreset
    return {
      power: parseFloat(powerSlider.value),
      directionSpread: parseFloat(directionSpreadSlider.value),
      speedVariation: parseFloat(speedVariationSlider.value),
      rotation: parseFloat(rotationSlider.value),
      aimEdge: aimEdgeCheckbox.checked,
      spawnLayout: (spawnLayoutSelect?.value as SpawnLayout) ?? 'grid',
      targetMode: (targetModeSelect?.value as TargetMode) ?? 'single',
      patternPreset
    }
  }

  const STORAGE_KEY = 'dice-recorder-defaults'
  type CameraPreset = { x: number; y: number; z: number }
  const HARDCODED_DEFAULTS = {
    power: 5,
    weight: 3,
    gravity: 9.81,
    glossiness: 0.88,
    lightIntensity: 0.8,
    lightAzimuth: 45,
    lightElevation: 50,
    lightColor: '#ffffff',
    lightAmbient: 0.35,
    directionSpread: 0.35,
    speedVariation: 0.3,
    rotation: 2,
    aimEdge: true,
    autoLoop: false,
    randomPreset: false,
    simSpeed: 2,
    diceCount: 6,
    gridSide: 2,
    maxConcurrent: 4,
    gridZoom: 1,
    spawnLayout: 'grid' as SpawnLayout,
    targetMode: 'single' as TargetMode,
    patternPreset: 'none' as PatternPreset,
    cameraPosition: { x: -6.35, y: 17.82, z: 0.24 } as CameraPreset,
    cameraTarget: { x: -2.61, y: -2.58, z: 0.25 } as CameraPreset,
    diceColors: {
      default: '#b91c1c',
      single: '#94a3b8',
      pair: '#0f52ba',
      triple: '#10b981',
      quad: '#7c3aed',
      five: '#f59e0b',
      six: '#dc2626',
      'small-straight': '#0891b2',
      'large-straight': '#6d28d9',
      'full-house': '#ea580c',
      'six-of-a-kind': '#b91c1c'
    }
  }

  const loadDefaults = (): typeof HARDCODED_DEFAULTS => {
    try {
      const s = localStorage.getItem(STORAGE_KEY)
      if (s) return { ...HARDCODED_DEFAULTS, ...JSON.parse(s) }
    } catch (_) {}
    return { ...HARDCODED_DEFAULTS }
  }

  let savedDefaults = loadDefaults()

  // Load dice colors from project file (public/dice-colors.json) if not in localStorage
  if (!savedDefaults.diceColors) {
    try {
      const r = await fetch('/dice-colors.json')
      if (r.ok) {
        const projectColors = (await r.json()) as Record<string, string>
        if (projectColors && typeof projectColors.default === 'string') {
          savedDefaults = { ...savedDefaults, diceColors: { ...HARDCODED_DEFAULTS.diceColors, ...projectColors } }
        }
      }
    } catch (_) {}
  }

  const applyDefaults = () => {
    const d = savedDefaults
    powerSlider.value = String(d.power)
    powerValue.textContent = String(d.power)
    weightSlider.value = String(d.weight ?? 3)
    weightValue.textContent = String(d.weight ?? 3)
    gravitySlider.value = String(d.gravity ?? 9.81)
    gravityValue.textContent = String(d.gravity ?? 9.81)
    directionSpreadSlider.value = String(d.directionSpread)
    directionSpreadValue.textContent = String(d.directionSpread)
    speedVariationSlider.value = String(d.speedVariation)
    speedVariationValue.textContent = String(d.speedVariation)
    rotationSlider.value = String(d.rotation)
    rotationValue.textContent = String(d.rotation)
    aimEdgeCheckbox.checked = d.aimEdge
    autoLoopCheckbox.checked = d.autoLoop
    if (randomPresetCheckbox && d.randomPreset != null) randomPresetCheckbox.checked = d.randomPreset
    const simSpeedEl = document.getElementById('sim-speed') as HTMLInputElement
    const simSpeedValEl = document.getElementById('sim-speed-value')!
    if (d.simSpeed != null) {
      simSpeedEl.value = String(d.simSpeed)
      simSpeedValEl.textContent = String(d.simSpeed)
    }
    if (d.diceCount != null) {
      diceCountSlider.value = String(d.diceCount)
      diceCountValueEl.textContent = String(d.diceCount)
    }
    if (d.gridSide != null) {
      gridSideSlider.value = String(d.gridSide)
      gridSideValueEl.textContent = String(d.gridSide)
    }
    if (d.maxConcurrent != null) {
      maxConcurrentSlider.value = String(d.maxConcurrent)
      maxConcurrentValueEl.textContent = String(d.maxConcurrent)
    }
    if ('gridZoom' in d && d.gridZoom != null) {
      gridZoomSlider.value = String(d.gridZoom)
      gridZoomValueEl.textContent = String(d.gridZoom)
    }
    if ('glossiness' in d && d.glossiness != null) {
      glossinessSlider.value = String(d.glossiness)
      glossinessValue.textContent = String(d.glossiness)
    }
    if ('lightIntensity' in d && d.lightIntensity != null) {
      lightIntensitySlider.value = String(d.lightIntensity)
      lightIntensityValue.textContent = String(d.lightIntensity)
    }
    if ('lightAzimuth' in d && d.lightAzimuth != null) {
      lightAzimuthSlider.value = String(d.lightAzimuth)
      lightAzimuthValue.textContent = String(d.lightAzimuth) + '°'
    }
    if ('lightElevation' in d && d.lightElevation != null) {
      lightElevationSlider.value = String(d.lightElevation)
      lightElevationValue.textContent = String(d.lightElevation) + '°'
    }
    if ('lightColor' in d && d.lightColor != null) {
      lightColorInput.value = d.lightColor
      lightColorValue.textContent = d.lightColor
    }
    if ('lightAmbient' in d && d.lightAmbient != null) {
      lightAmbientSlider.value = String(d.lightAmbient)
      lightAmbientValue.textContent = String(d.lightAmbient)
    }
    applyLighting()
    if (spawnLayoutSelect && d.spawnLayout != null) spawnLayoutSelect.value = d.spawnLayout
    if (targetModeSelect && d.targetMode != null) targetModeSelect.value = d.targetMode
    if (patternPresetSelect && d.patternPreset != null) patternPresetSelect.value = d.patternPreset
    buildRooms()
    for (const r of rooms) {
      updateDiceMass(r.physics, getWeight())
      setGravity(r.physics, getGravity())
    }
    if (previewPhysics) {
      updateDiceMass(previewPhysics, getWeight())
      setGravity(previewPhysics, getGravity())
    }
    const g = getGlossiness()
    for (const r of rooms) setDiceGlossiness(r.diceMeshes, g)
    if (previewDiceMeshes.length) setDiceGlossiness(previewDiceMeshes, g)
    setDiceGlossiness([diceModel], g)
    if (d.diceColors) {
      const dc = d.diceColors as Record<string, string>
      const defaultEl = document.getElementById('dice-color-default') as HTMLInputElement
      if (defaultEl && dc.default) defaultEl.value = dc.default
      for (const slug of ['single', 'pair', 'triple', 'quad', 'five', 'six', 'small-straight', 'large-straight', 'full-house', 'six-of-a-kind']) {
        const el = document.getElementById(`dice-color-${slug}`) as HTMLInputElement
        if (el && dc[slug]) el.value = dc[slug]
      }
      applyDiceColorsFromUI()
      reapplyDiceComboVFX()
    }
  }

  const saveCameraPosition = () => {
    savedDefaults = {
      ...savedDefaults,
      cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      cameraTarget: { x: controls.target.x, y: controls.target.y, z: controls.target.z }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDefaults))
    } catch (_) {}
    showNotification('Camera position saved', 'info')
  }

  const resetCameraPosition = () => {
    savedDefaults = { ...savedDefaults, cameraPosition: HARDCODED_DEFAULTS.cameraPosition, cameraTarget: HARDCODED_DEFAULTS.cameraTarget }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDefaults))
    } catch (_) {}
    if (screenMode === 'preview') {
      const cp = HARDCODED_DEFAULTS.cameraPosition
      const ct = HARDCODED_DEFAULTS.cameraTarget
      camera.position.set(cp.x, cp.y, cp.z)
      controls.target.set(ct.x, ct.y, ct.z)
    }
    showNotification('Camera reset to default', 'info')
  }

  const saveAsDefaults = () => {
    const opts = getThrowOptions()
    savedDefaults = {
      power: opts.power ?? 5,
      weight: getWeight(),
      gravity: getGravity(),
      glossiness: getGlossiness(),
      lightIntensity: parseFloat(lightIntensitySlider?.value ?? '0.8'),
      lightAzimuth: parseFloat(lightAzimuthSlider?.value ?? '45'),
      lightElevation: parseFloat(lightElevationSlider?.value ?? '50'),
      lightColor: lightColorInput?.value ?? '#ffffff',
      lightAmbient: parseFloat(lightAmbientSlider?.value ?? '0.35'),
      directionSpread: opts.directionSpread ?? 0.35,
      speedVariation: opts.speedVariation ?? 0.3,
      rotation: opts.rotation ?? 2,
      aimEdge: opts.aimEdge ?? true,
      autoLoop: autoLoopCheckbox.checked,
      randomPreset: randomPresetCheckbox?.checked ?? false,
      simSpeed: parseInt((document.getElementById('sim-speed') as HTMLInputElement).value, 10),
      diceCount: getDiceCount(),
      gridSide: getGridSide(),
      maxConcurrent: getMaxConcurrent(),
      gridZoom: getGridZoom(),
      spawnLayout: opts.spawnLayout ?? 'grid',
      targetMode: opts.targetMode ?? 'single',
      patternPreset: opts.patternPreset ?? 'none',
      cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      cameraTarget: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      diceColors: (() => {
        const dc = { ...HARDCODED_DEFAULTS.diceColors }
        const defaultEl = document.getElementById('dice-color-default') as HTMLInputElement
        if (defaultEl) dc.default = defaultEl.value
        for (const slug of ['single', 'pair', 'triple', 'quad', 'five', 'six', 'small-straight', 'large-straight', 'full-house', 'six-of-a-kind']) {
          const el = document.getElementById(`dice-color-${slug}`) as HTMLInputElement
          if (el) dc[slug as keyof typeof dc] = el.value
        }
        return dc
      })()
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDefaults))
    } catch (_) {}
  }

  powerSlider.addEventListener('input', () => { powerValue.textContent = powerSlider.value })
  glossinessSlider.addEventListener('input', () => {
    glossinessValue.textContent = glossinessSlider.value
    const g = getGlossiness()
    for (const r of rooms) setDiceGlossiness(r.diceMeshes, g)
    if (previewDiceMeshes.length) setDiceGlossiness(previewDiceMeshes, g)
    setDiceGlossiness([diceModel], g)
  })

  let dicePreviewLight: THREE.DirectionalLight | null = null
  let dicePreviewAmbient: THREE.AmbientLight | null = null

  function applyLighting() {
    const intensity = parseFloat(lightIntensitySlider?.value ?? '0.8')
    const azimuth = parseFloat(lightAzimuthSlider?.value ?? '45')
    const elevation = parseFloat(lightElevationSlider?.value ?? '50')
    const colorHex = lightColorInput?.value ?? '#ffffff'
    const ambient = parseFloat(lightAmbientSlider?.value ?? '0.35')
    lighting.mainLight.intensity = intensity
    lighting.mainLight.color.setStyle(colorHex)
    setMainLightDirection(lighting.mainLight, azimuth, elevation)
    lighting.ambientLight.intensity = ambient
    lighting.ambientLight.color.setStyle(colorHex)
    if (dicePreviewLight) {
      dicePreviewLight.intensity = intensity
      dicePreviewLight.color.setStyle(colorHex)
      setMainLightDirection(dicePreviewLight, azimuth, elevation)
    }
    if (dicePreviewAmbient) {
      dicePreviewAmbient.intensity = ambient
      dicePreviewAmbient.color.setStyle(colorHex)
    }
  }
  lightIntensitySlider?.addEventListener('input', () => {
    lightIntensityValue.textContent = lightIntensitySlider.value
    applyLighting()
  })
  lightAzimuthSlider?.addEventListener('input', () => {
    lightAzimuthValue.textContent = lightAzimuthSlider.value + '°'
    applyLighting()
  })
  lightElevationSlider?.addEventListener('input', () => {
    lightElevationValue.textContent = lightElevationSlider.value + '°'
    applyLighting()
  })
  lightColorInput?.addEventListener('input', () => {
    lightColorValue.textContent = lightColorInput.value
    applyLighting()
  })
  lightAmbientSlider?.addEventListener('input', () => {
    lightAmbientValue.textContent = lightAmbientSlider.value
    applyLighting()
  })

  const DICE_COLOR_IDS = ['default', 'single', 'pair', 'triple', 'quad', 'five', 'six', 'small-straight', 'large-straight', 'full-house', 'six-of-a-kind'] as const
  function applyDiceColorsFromUI() {
    const defaultEl = document.getElementById('dice-color-default') as HTMLInputElement
    const defaultHex = defaultEl ? parseInt(defaultEl.value.slice(1), 16) : 0xb91c1c
    setDiceDefaultColor(defaultHex)
    const combos: Record<string, number> = {}
    for (const id of DICE_COLOR_IDS) {
      if (id === 'default') continue
      const el = document.getElementById(`dice-color-${id}`) as HTMLInputElement
      if (el) combos[id] = parseInt(el.value.slice(1), 16)
    }
    setDiceComboColors(combos)
    if (diceModel?.children[0] instanceof THREE.Mesh && diceModel.children[0].material instanceof THREE.MeshPhysicalMaterial) {
      const mat = diceModel.children[0].material
      mat.color.setHex(defaultHex)
      mat.emissive.setHex(0)
    }
  }
  function reapplyDiceComboVFX() {
    for (const room of rooms) {
      if (room.physics.simulatingThrow || room.physics.pendingThrow) continue
      if (isSettled(room.physics, SETTLE_THRESHOLD)) {
        const diceResult = getDiceResult(room.physics)
        const breakdown = computeScoreBreakdown(diceResult)
        applyDiceComboVFX(room.diceMeshes, diceResult, breakdown.badges)
      } else {
        clearDiceComboVFX(room.diceMeshes)
      }
    }
    if (previewPhysics && previewDiceMeshes.length && !previewPhysics.simulatingThrow && !previewPhysics.pendingThrow && isSettled(previewPhysics, SETTLE_THRESHOLD)) {
      const diceResult = getDiceResult(previewPhysics)
      const breakdown = computeScoreBreakdown(diceResult)
      applyDiceComboVFX(previewDiceMeshes, diceResult, breakdown.badges)
    } else if (previewDiceMeshes.length) {
      clearDiceComboVFX(previewDiceMeshes)
    }
  }
  function saveDiceColorsToStorage() {
    const dc = { ...HARDCODED_DEFAULTS.diceColors }
    const defaultEl = document.getElementById('dice-color-default') as HTMLInputElement
    if (defaultEl) dc.default = defaultEl.value
    for (const slug of ['single', 'pair', 'triple', 'quad', 'five', 'six', 'small-straight', 'large-straight', 'full-house', 'six-of-a-kind']) {
      const el = document.getElementById(`dice-color-${slug}`) as HTMLInputElement
      if (el) dc[slug as keyof typeof dc] = el.value
    }
    savedDefaults = { ...savedDefaults, diceColors: dc }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDefaults))
    } catch (_) {}
  }
  function setupDiceColorPickers() {
    applyDiceColorsFromUI()
    for (const id of DICE_COLOR_IDS) {
      const el = document.getElementById(`dice-color-${id}`) as HTMLInputElement
      if (el) {
        el.addEventListener('input', () => {
          applyDiceColorsFromUI()
          reapplyDiceComboVFX()
          saveDiceColorsToStorage()
        })
      }
    }
    const resetBtn = document.getElementById('dice-colors-reset')
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const def = getDefaultDiceColors()
        const defaultEl = document.getElementById('dice-color-default') as HTMLInputElement
        if (defaultEl) defaultEl.value = '#' + def.default.toString(16).padStart(6, '0')
        for (const [slug, hex] of Object.entries(def.combos)) {
          const el = document.getElementById(`dice-color-${slug}`) as HTMLInputElement
          if (el) el.value = '#' + hex.toString(16).padStart(6, '0')
        }
        applyDiceColorsFromUI()
        reapplyDiceComboVFX()
        saveDiceColorsToStorage()
      })
    }
    const saveProjectBtn = document.getElementById('dice-colors-save-project')
    if (saveProjectBtn) {
      saveProjectBtn.addEventListener('click', () => {
        const dc: Record<string, string> = {}
        const defaultEl = document.getElementById('dice-color-default') as HTMLInputElement
        if (defaultEl) dc.default = defaultEl.value
        for (const slug of ['single', 'pair', 'triple', 'quad', 'five', 'six', 'small-straight', 'large-straight', 'full-house', 'six-of-a-kind']) {
          const el = document.getElementById(`dice-color-${slug}`) as HTMLInputElement
          if (el) dc[slug] = el.value
        }
        const blob = new Blob([JSON.stringify(dc, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'dice-colors.json'
        a.click()
        URL.revokeObjectURL(a.href)
        showNotification('Saved dice-colors.json — put in public/ folder and commit', 'info')
      })
    }
  }
  setupDiceColorPickers()

  weightSlider.addEventListener('input', () => {
    weightValue.textContent = weightSlider.value
    for (const r of rooms) updateDiceMass(r.physics, getWeight())
    if (previewPhysics) updateDiceMass(previewPhysics, getWeight())
  })
  gravitySlider.addEventListener('input', () => {
    gravityValue.textContent = gravitySlider.value
    for (const r of rooms) setGravity(r.physics, getGravity())
    if (previewPhysics) setGravity(previewPhysics, getGravity())
  })
  directionSpreadSlider.addEventListener('input', () => { directionSpreadValue.textContent = directionSpreadSlider.value })
  speedVariationSlider.addEventListener('input', () => { speedVariationValue.textContent = speedVariationSlider.value })
  rotationSlider.addEventListener('input', () => { rotationValue.textContent = rotationSlider.value })
  document.getElementById('sim-speed')!.addEventListener('input', (e) => {
    document.getElementById('sim-speed-value')!.textContent = (e.target as HTMLInputElement).value
  })
  diceCountSlider.addEventListener('input', () => {
    diceCountValueEl.textContent = diceCountSlider.value
    buildRooms()
    if (screenMode === 'preview') {
      rooms.forEach(r => { r.group.visible = false })
      destroyPreviewRoom()
      ensurePreviewRoom()
    }
  })
  gridSideSlider.addEventListener('input', () => {
    gridSideValueEl.textContent = gridSideSlider.value
    buildRooms()
  })
  maxConcurrentSlider.addEventListener('input', updateMaxConcurrentLabel)
  gridZoomSlider.addEventListener('input', () => {
    gridZoomValueEl.textContent = gridZoomSlider.value
    if (screenMode === 'grid' && !isFocusedOnRoom && !cameraAnimation) {
      const zoom = getGridZoom()
      const { position, target } = getCameraForAllRooms(getGridSide(), ROOM_SPACING, zoom, cameraView)
      camera.position.copy(position)
      controls.target.copy(target)
    }
  })

  tabSixes.addEventListener('click', () => setScreenMode('sixes'))
  tabGrid.addEventListener('click', () => setScreenMode('grid'))
  tabPreview.addEventListener('click', () => setScreenMode('preview'))
  tabProbability.addEventListener('click', () => setScreenMode('probability'))
  backToGridBtn.addEventListener('click', () => setScreenMode('grid'))

  function countActiveSims(): number {
    return rooms.filter(r => r.physics.simulatingThrow || r.physics.pendingThrow != null).length
  }

  function doThrowForRoom(room: RoomState, opts?: { seed?: number }) {
    clearDiceComboVFX(room.diceMeshes)
    const seed = opts?.seed ?? Date.now() + room.roomIndex * 1000
    const options = getThrowOptions({ seed })
    room.lastThrow = { seed, options, weight: getWeight(), gravity: getGravity() }
    room.hasRecordedThisThrow = false
    room.physics.currentMass = room.lastThrow.weight
    room.physics.currentGravity = room.lastThrow.gravity
    throwDice(room.physics, { ...options, seed })
    room.settledFrameCount = 0
    room.lastThrowTime = performance.now()
  }

  function queueThrows() {
    const maxConcurrent = getMaxConcurrent()
    const active = countActiveSims()
    if (active >= maxConcurrent) return
    const idle = rooms.filter(r => !r.physics.simulatingThrow && r.physics.pendingThrow == null)
    const toStart = Math.min(maxConcurrent - active, idle.length)
    for (let i = 0; i < toStart; i++) {
      doThrowForRoom(idle[i])
    }
  }

  document.getElementById('grid-throw-btn')!.addEventListener('click', queueThrows)

  const fullscreenBtn = document.getElementById('fullscreen-btn')!
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      container.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  })
  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? '⛶' : '⛶'
    fullscreenBtn.title = document.fullscreenElement ? 'Exit full screen (F or Esc)' : 'Full screen (F)'
  })

  const cameraViewBtn = document.getElementById('camera-view-btn')!
  function updateCameraViewButton() {
    cameraViewBtn.textContent = cameraView === 'top' ? '↑' : '↓'
    cameraViewBtn.title = cameraView === 'top' ? 'Switch to bottom view' : 'Switch to top view'
  }
  cameraViewBtn.addEventListener('click', () => {
    cameraView = cameraView === 'top' ? 'bottom' : 'top'
    updateCameraViewButton()
    let position: THREE.Vector3
    let target: THREE.Vector3
    if (screenMode === 'grid') {
      if (isFocusedOnRoom && focusedRoomIndex != null) {
        const center = roomCenter(focusedRoomIndex)
        ;({ position, target } = getCameraForRoom(center, cameraView))
      } else {
        const zoom = getGridZoom()
        ;({ position, target } = getCameraForAllRooms(getGridSide(), ROOM_SPACING, zoom, cameraView))
      }
    } else if (screenMode === 'preview') {
      ;({ position, target } = getCameraForRoom(new THREE.Vector3(0, 0, 0), cameraView))
    } else {
      return
    }
    cameraAnimation = startCameraAnimation(camera, controls, position, target)
  })

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable

    if (e.code === 'Backquote' && !inInput) {
      e.preventDefault()
      setGameMode(!gameMode)
      return
    }
    if (e.code === 'KeyF' && !inInput) {
      e.preventDefault()
      if (!document.fullscreenElement) {
        container.requestFullscreen?.()
      } else {
        document.exitFullscreen?.()
      }
      return
    }
    if (e.code === 'Space') {
      if (inInput) return
      e.preventDefault()
      if (screenMode === 'grid') {
        queueThrows()
      } else if (screenMode === 'preview') {
        ensurePreviewRoom()
        clearDiceComboVFX(previewDiceMeshes)
        const opts = getThrowOptions({ seed: Date.now() })
        previewPhysics!.currentMass = getWeight()
        previewPhysics!.currentGravity = getGravity()
        setGravity(previewPhysics!, getGravity())
        previewLastThrow = { seed: opts.seed ?? Date.now(), options: opts, weight: getWeight(), gravity: getGravity() }
        throwDice(previewPhysics!, opts)
      }
    }
  })

  document.getElementById('test-luck-btn')!.addEventListener('click', () => {
    if (screenMode === 'preview') {
      ensurePreviewRoom()
      clearDiceComboVFX(previewDiceMeshes)
      const opts = getThrowOptions({ seed: Date.now() })
      previewPhysics!.currentMass = getWeight()
      previewPhysics!.currentGravity = getGravity()
      setGravity(previewPhysics!, getGravity())
      previewLastThrow = { seed: opts.seed ?? Date.now(), options: opts, weight: getWeight(), gravity: getGravity() }
      throwDice(previewPhysics!, opts)
    } else if (screenMode === 'grid') {
      queueThrows()
    }
  })

  document.getElementById('preview-throw-btn')!.addEventListener('click', () => {
    ensurePreviewRoom()
    clearDiceComboVFX(previewDiceMeshes)
    const opts = getThrowOptions({ seed: Date.now() })
    previewPhysics!.currentMass = getWeight()
    previewPhysics!.currentGravity = getGravity()
    setGravity(previewPhysics!, getGravity())
    previewLastThrow = { seed: opts.seed ?? Date.now(), options: opts, weight: getWeight(), gravity: getGravity() }
    throwDice(previewPhysics!, opts)
  })

  allRoomsBtn.addEventListener('click', () => {
    isFocusedOnRoom = false
    focusedRoomIndex = null
    const zoom = getGridZoom()
    const { position, target } = getCameraForAllRooms(getGridSide(), ROOM_SPACING, zoom, cameraView)
    cameraAnimation = startCameraAnimation(camera, controls, position, target)
  })

  autoLoopCheckbox.addEventListener('change', () => {
    if (autoLoopCheckbox.checked) {
      for (const r of rooms) r.settledFrameCount = 0
    }
  })

  function focusOnRoom(roomIndex: number) {
    if (focusedRoomIndex === roomIndex) return
    isFocusedOnRoom = true
    focusedRoomIndex = roomIndex
    const center = roomCenter(roomIndex)
    const { position, target } = getCameraForRoom(center, cameraView)
    cameraAnimation = startCameraAnimation(camera, controls, position, target)
  }

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

  container.addEventListener('click', (e: MouseEvent) => {
    if (screenMode !== 'grid' || cameraAnimation) return
    const rect = container.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(mouse, camera)
    const roomGroups = rooms.map(r => r.group)
    const intersects = raycaster.intersectObjects(roomGroups, true)
    if (intersects.length > 0) {
      let obj: THREE.Object3D | null = intersects[0].object
      while (obj) {
        if (obj.userData.roomIndex !== undefined) {
          const idx = obj.userData.roomIndex as number
          if (focusedRoomIndex === idx) return
          focusOnRoom(idx)
          return
        }
        obj = obj.parent
      }
    }
  })

  const recalculateStatsBtn = document.getElementById('recalculate-stats-btn') as HTMLButtonElement
  const recalculateStatsStatus = document.getElementById('recalculate-stats-status')!
  recalculateStatsBtn.addEventListener('click', async () => {
    recalculateStatsBtn.disabled = true
    recalculateStatsStatus.textContent = 'Running…'
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 330_000)
    try {
      const r = await fetch('/api/recalculate-stats', {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      let d: { ok?: boolean; totalThrows?: number; error?: string }
      try {
        d = await r.json()
      } catch {
        recalculateStatsStatus.textContent = r.ok ? 'Invalid response' : `Error ${r.status}`
        return
      }
      if (d.ok) {
        recalculateStatsStatus.textContent = `Done: ${d.totalThrows} throws`
        fetchGlobalStats()
      } else {
        recalculateStatsStatus.textContent = d.error ?? 'Failed'
      }
    } catch (err) {
      clearTimeout(timeoutId)
      recalculateStatsStatus.textContent =
        err instanceof Error && err.name === 'AbortError' ? 'Timed out (5.5 min)' : 'Network error'
    } finally {
      recalculateStatsBtn.disabled = false
      setTimeout(() => { recalculateStatsStatus.textContent = '' }, 5000)
    }
  })

  document.getElementById('save-defaults-btn')!.addEventListener('click', saveAsDefaults)
  document.getElementById('defaults-btn')!.addEventListener('click', applyDefaults)
  document.getElementById('export-defaults-btn')!.addEventListener('click', () => {
    const json = JSON.stringify(savedDefaults, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'defaults.json'
    a.click()
    URL.revokeObjectURL(a.href)
    showNotification('Downloaded current settings as defaults.json', 'info')
  })
  document.getElementById('save-camera-btn')!.addEventListener('click', saveCameraPosition)
  document.getElementById('reset-camera-btn')!.addEventListener('click', resetCameraPosition)

  const handleResize = () => onResize(sceneState, container)
  window.addEventListener('resize', handleResize)
  const resizeObserver = new ResizeObserver(handleResize)
  resizeObserver.observe(container)

  const simSpeedSlider = document.getElementById('sim-speed') as HTMLInputElement

  // Dice preview: camera, lights, controls (scene/env/dice already created above)
  const dicePreviewCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  dicePreviewCamera.position.set(2.2, 2.2, 2.2)
  dicePreviewCamera.lookAt(0, 0, 0)
  dicePreviewAmbient = new THREE.AmbientLight(0xffffff, 0.35)
  dicePreviewScene.add(dicePreviewAmbient)
  dicePreviewLight = new THREE.DirectionalLight(0xffffff, 0.8)
  dicePreviewLight.position.set(2, 3, 2)
  dicePreviewScene.add(dicePreviewLight)

  const dicePreviewControls = new OrbitControls(dicePreviewCamera, dicePreviewContainer)
  dicePreviewControls.enableDamping = true
  dicePreviewControls.dampingFactor = 0.05
  dicePreviewControls.target.set(0, 0, 0)
  dicePreviewControls.minDistance = 1.5
  dicePreviewControls.maxDistance = 6

  function resizeDicePreview() {
    const w = dicePreviewContainer.clientWidth
    const h = dicePreviewContainer.clientHeight
    if (w > 0 && h > 0) {
      dicePreviewCanvas.width = w
      dicePreviewCanvas.height = h
      dicePreviewRenderer.setSize(w, h)
      dicePreviewCamera.aspect = w / h
      dicePreviewCamera.updateProjectionMatrix()
    }
  }
  resizeDicePreview()
  window.addEventListener('resize', resizeDicePreview)

  const cameraPosEl = document.getElementById('camera-pos')!
  const cameraTargetEl = document.getElementById('camera-target')!
  const cameraRotationEl = document.getElementById('camera-rotation')!

  function updateCameraDebugDisplay(cam: THREE.PerspectiveCamera, ctrl: OrbitControls) {
    const fmt = (n: number) => n.toFixed(2)
    cameraPosEl.textContent = `(${fmt(cam.position.x)}, ${fmt(cam.position.y)}, ${fmt(cam.position.z)})`
    cameraTargetEl.textContent = `(${fmt(ctrl.target.x)}, ${fmt(ctrl.target.y)}, ${fmt(ctrl.target.z)})`
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1)
    cameraRotationEl.textContent = `(${deg(cam.rotation.x)}°, ${deg(cam.rotation.y)}°, ${deg(cam.rotation.z)}°)`
  }

  applyDefaults()
  setGameMode(true)
  initMobileLayout()
  if (!gameMode) {
    queueThrows()
  }

  let lastFrameTime = performance.now()
  let accumulatedTime = 0
  let fpsFrameCount = 0
  let fpsMeasureStart = performance.now()
  let fpsAutoBoostDone = false
  function animate() {
    requestAnimationFrame(animate)
    const now = performance.now()
    const deltaSec = Math.min(Math.max(0, (now - lastFrameTime) / 1000), 0.1)
    lastFrameTime = now
    const simSpeedRaw = parseInt(simSpeedSlider.value, 10)
    const simSpeed = Number.isNaN(simSpeedRaw) ? 1 : Math.max(0, simSpeedRaw)

    // Auto-boost sim speed for slow browsers (once, after ~1s warmup)
    if (!fpsAutoBoostDone) {
      fpsFrameCount++
      const elapsed = now - fpsMeasureStart
      if (elapsed >= 1000) {
        const avgFps = fpsFrameCount / (elapsed / 1000)
        if (avgFps < 30 && simSpeed <= 2) {
          const boost = Math.min(10, Math.max(2, Math.ceil(30 / avgFps)))
          simSpeedSlider.value = String(boost)
          document.getElementById('sim-speed-value')!.textContent = String(boost)
          setPerformanceMode(sceneState, container)
          showNotification('Performance mode: sim speed increased for smoother playback', 'info')
        }
        fpsAutoBoostDone = true
      }
    }
    const fixedStep = getFixedStep()
    accumulatedTime += deltaSec * simSpeed
    // Allow broad catch-up so simulation speed stays real-time in slower browsers.
    accumulatedTime = Math.min(accumulatedTime, fixedStep * 240)
    const stepsPerFrame = Math.min(Math.floor(accumulatedTime / fixedStep), 240)
    if (stepsPerFrame > 0) {
      accumulatedTime -= stepsPerFrame * fixedStep
    }

    if (cameraAnimation) {
      if (updateCameraAnimation(camera, controls, cameraAnimation)) {
        cameraAnimation = null
      }
    }

    if (screenMode === 'preview' && previewPhysics) {
      stepPhysics(previewPhysics, stepsPerFrame)
      if (isSettled(previewPhysics, SETTLE_THRESHOLD)) {
        const diceResult = getDiceResult(previewPhysics)
        const breakdown = computeScoreBreakdown(diceResult)
        applyDiceComboVFX(previewDiceMeshes, diceResult, breakdown.badges)
        if (previewLastThrow) {
          addHistoryEntry({
            ...previewLastThrow,
            diceResult,
            time: Date.now(),
            roomIndex: 0,
            score: computeScore(diceResult)
          })
          previewLastThrow = null
        }
      }
      for (let i = 0; i < previewPhysics.diceBodies.length; i++) {
        syncRigidBodyToMesh(previewPhysics.diceBodies[i], previewDiceMeshes[i])
      }
    } else {
      const maxConcurrent = getMaxConcurrent()
      let activeCount = 0

      for (const room of rooms) {
        if (room.physics.simulatingThrow || room.physics.pendingThrow != null) {
          activeCount++
          if (activeCount <= maxConcurrent) {
            stepPhysics(room.physics, stepsPerFrame)
          }
        }
        for (let i = 0; i < room.physics.diceBodies.length; i++) {
          syncRigidBodyToMesh(room.physics.diceBodies[i], room.diceMeshes[i])
        }

        if (isOutOfBounds(room.physics)) {
          if (room.lastThrow && !room.hasRecordedThisThrow) {
            room.hasRecordedThisThrow = true
            addHistoryEntry({ ...room.lastThrow, diceResult: [], escaped: true, time: Date.now(), roomIndex: room.roomIndex, score: 0 })
          }
          room.physics.simulatingThrow = false
          room.settledFrameCount = 0
          if (autoLoopCheckbox.checked && countActiveSims() < maxConcurrent) {
            doThrowForRoom(room)
          }
        } else if (isSettled(room.physics, SETTLE_THRESHOLD)) {
          if (room.lastThrow && !room.hasRecordedThisThrow) {
            const diceResult = getDiceResult(room.physics)
            const breakdown = computeScoreBreakdown(diceResult)
            applyDiceComboVFX(room.diceMeshes, diceResult, breakdown.badges)
            room.hasRecordedThisThrow = true
            addHistoryEntry({ ...room.lastThrow, diceResult, time: Date.now(), roomIndex: room.roomIndex, score: computeScore(diceResult) })
          }
          if (autoLoopCheckbox.checked) {
            const effectiveSpeed = Math.max(0.1, simSpeed)
            const settleFrames = Math.max(1, Math.ceil(BASE_SETTLE_FRAMES / effectiveSpeed))
            const delayMs = Math.max(50, BASE_LOOP_DELAY_MS / effectiveSpeed)
            room.settledFrameCount++
            if (room.settledFrameCount >= settleFrames) {
              if (now - room.lastThrowTime >= delayMs) {
                if (countActiveSims() < maxConcurrent) {
                  doThrowForRoom(room)
                }
                room.settledFrameCount = 0
                room.lastThrowTime = performance.now()
              }
            }
          } else {
            room.settledFrameCount = 0
          }
        } else {
          room.settledFrameCount = 0
        }
      }
    }

    // Update wall transparency for obstructing walls (camera between wall and dice)
    if (screenMode === 'preview' && previewGroup?.visible) {
      updateWallTransparency(previewGroup, camera.position)
    } else if (screenMode === 'grid') {
      for (const r of rooms) {
        if (r.group.visible) updateWallTransparency(r.group, camera.position)
      }
    }

    controls.update()
    updateCameraDebugDisplay(camera, controls)
    renderer.render(scene, camera)

    dicePreviewControls.update()
    dicePreviewRenderer.render(dicePreviewScene, dicePreviewCamera)
  }

  animate()
}

async function bootstrap() {
  try {
    await init()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;inset:0;background:#1a1a2e;color:#e74c3c;padding:24px;font-family:monospace;font-size:14px;overflow:auto;z-index:9999'
    el.textContent = `Failed to start: ${msg}\n\n${err instanceof Error ? err.stack : ''}`
    document.body.prepend(el)
    console.error('Init error:', err)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => requestAnimationFrame(bootstrap)))
} else {
  requestAnimationFrame(() => requestAnimationFrame(bootstrap))
}
