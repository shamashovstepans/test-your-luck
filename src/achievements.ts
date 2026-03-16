/** Achievement system: 28 achievements in 6 groups. */

const STORAGE_KEY = 'dice:achievements:v2'

/** N-of-a-kind: 3,4,5,6 × 6 values = 24 achievements. */
const N_OF_A_KIND_IDS: string[] = []
for (let n = 3; n <= 6; n++) {
  for (let v = 1; v <= 6; v++) {
    N_OF_A_KIND_IDS.push(String(v).repeat(n))
  }
}

/** Special achievements: 4 total. */
const LARGE_STRAIGHT = 'large-straight'
const SMALL_STRAIGHT = 'small-straight'
const TWO_PAIR = 'two-pair'
const THREE_PAIR = 'three-pair'

const SPECIAL_IDS = [LARGE_STRAIGHT, SMALL_STRAIGHT, TWO_PAIR, THREE_PAIR]

export const ALL_ACHIEVEMENT_IDS = [...N_OF_A_KIND_IDS, ...SPECIAL_IDS]
export const TOTAL_ACHIEVEMENTS = ALL_ACHIEVEMENT_IDS.length

function getCounts(diceResult: number[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0]
  for (const v of diceResult) {
    if (v >= 1 && v <= 6) counts[v - 1]++
  }
  return counts
}

function getSignature(counts: number[]): string {
  return counts.filter((c) => c > 0).sort((a, b) => b - a).join('-')
}

function isSmallStraight(counts: number[]): boolean {
  const has12345 = [1, 2, 3, 4, 5].every((v) => (counts[v - 1] ?? 0) >= 1)
  const has23456 = [2, 3, 4, 5, 6].every((v) => (counts[v - 1] ?? 0) >= 1)
  return has12345 || has23456
}

/** Get all achievement IDs unlocked by this throw. */
export function getAchievementsToClaim(diceResult: number[]): string[] {
  if (diceResult.length !== 6) return []

  const counts = getCounts(diceResult)
  const unlocked: string[] = []

  for (let v = 1; v <= 6; v++) {
    const n = counts[v - 1] ?? 0
    if (n >= 3) unlocked.push(String(v).repeat(3))
    if (n >= 4) unlocked.push(String(v).repeat(4))
    if (n >= 5) unlocked.push(String(v).repeat(5))
    if (n >= 6) unlocked.push(String(v).repeat(6))
  }

  const sig = getSignature(counts)
  if (sig === '1-1-1-1-1-1') unlocked.push(LARGE_STRAIGHT)
  if (sig === '2-1-1-1-1' && isSmallStraight(counts)) unlocked.push(SMALL_STRAIGHT)
  if (sig === '2-2-1-1') unlocked.push(TWO_PAIR)
  if (sig === '2-2-2') unlocked.push(THREE_PAIR)

  return unlocked
}

export function isNOfAKindAchievement(id: string): boolean {
  return N_OF_A_KIND_IDS.includes(id)
}

/** Display name for an achievement. */
export function getAchievementDisplayName(id: string): string {
  if (id === LARGE_STRAIGHT) return 'Large straight (1-2-3-4-5-6)'
  if (id === SMALL_STRAIGHT) return 'Small straight (1-5 or 2-6)'
  if (id === TWO_PAIR) return 'Two pair'
  if (id === THREE_PAIR) return 'Three pair'
  return id.split('').join('-')
}

/** Number emojis 1–6 for N-of-a-kind – show the dice value. */
const VALUE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣']

/** Parts for N-of-a-kind (for multi-line wrap), or null for single icon. */
export function getAchievementIconParts(id: string): { emoji: string; count: number } | null {
  if (!/^\d+$/.test(id)) return null
  const v = parseInt(id[0], 10)
  return { emoji: VALUE_EMOJI[v - 1] ?? '?', count: id.length }
}

/** Icon for an achievement. */
export function getAchievementIcon(id: string): string {
  if (id === LARGE_STRAIGHT) return '📐'
  if (id === SMALL_STRAIGHT) return '📏'
  if (id === TWO_PAIR) return '🔗'
  if (id === THREE_PAIR) return '🎴'
  const parts = getAchievementIconParts(id)
  return parts ? parts.emoji.repeat(parts.count) : '?'
}

/** Rarity tier for styling (rarest first). */
export type AchievementRarity = 'six' | 'five' | 'four' | 'three' | 'straight' | 'special'

export function getAchievementRarity(id: string): AchievementRarity {
  if (id.length === 6) return 'six'
  if (id.length === 5) return 'five'
  if (id.length === 4) return 'four'
  if (id.length === 3) return 'three'
  if (id === LARGE_STRAIGHT || id === SMALL_STRAIGHT) return 'straight'
  return 'special'
}

/** Load claimed achievement IDs from localStorage. */
export function loadClaimedAchievements(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveClaimedAchievements(claimed: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...claimed]))
  } catch {
    /* ignore */
  }
}

let claimedCache: Set<string> | null = null

function getClaimed(): Set<string> {
  if (claimedCache == null) claimedCache = loadClaimedAchievements()
  return claimedCache
}

/** Claim achievements; returns newly claimed IDs. */
export function claimAchievements(ids: string[]): string[] {
  const claimed = getClaimed()
  const newlyClaimed: string[] = []
  for (const id of ids) {
    if (id && !claimed.has(id)) {
      claimed.add(id)
      newlyClaimed.push(id)
    }
  }
  if (newlyClaimed.length > 0) {
    saveClaimedAchievements(claimed)
  }
  return newlyClaimed
}

/** Get achievements grouped by rarity, rarest first. */
export function getAchievementsGroupedByRarity(): { groupName: string; ids: string[] }[] {
  return [
    { groupName: 'Six of a kind', ids: ['111111', '222222', '333333', '444444', '555555', '666666'] },
    { groupName: 'Five of a kind', ids: ['11111', '22222', '33333', '44444', '55555', '66666'] },
    { groupName: 'Four of a kind', ids: ['1111', '2222', '3333', '4444', '5555', '6666'] },
    { groupName: 'Three of a kind', ids: ['111', '222', '333', '444', '555', '666'] },
    { groupName: 'Straights', ids: [LARGE_STRAIGHT, SMALL_STRAIGHT] },
    { groupName: 'Special', ids: [TWO_PAIR, THREE_PAIR] }
  ]
}
