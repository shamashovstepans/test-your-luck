/** Server-side scoring utils for retrospective recalculation. Must match client logic. */

const RARITY_PATTERNS: { id: string; name: string }[] = [
  { id: '6', name: 'Six of a kind' },
  { id: '5-1', name: 'Five of a kind' },
  { id: '4-2', name: 'Four + pair' },
  { id: '4-1-1', name: 'Four of a kind' },
  { id: '3-2-1', name: 'Three + pair' },
  { id: '3-1-1-1', name: 'Three of a kind' },
  { id: '2-2-2', name: 'Three pairs' },
  { id: '2-2-1-1', name: 'Two pairs' },
  { id: '1-1-1-1-1-1', name: 'Large straight' },
  { id: 'small-straight', name: 'Small straight' }
]

function getRarityPattern(diceResult: number[]): { name: string } | null {
  if (diceResult.length !== 6) return null
  const counts = [0, 0, 0, 0, 0, 0]
  for (const v of diceResult) {
    if (v >= 1 && v <= 6) counts[v - 1]++
  }
  const sig = counts.filter((c) => c > 0).sort((a, b) => b - a)
  const sigStr = sig.join('-')
  if (sigStr === '2-1-1-1-1') {
    const vals = [1, 2, 3, 4, 5, 6].filter((v) => counts[v - 1] >= 1)
    const has12345 = [1, 2, 3, 4, 5].every((d) => vals.includes(d))
    const has23456 = [2, 3, 4, 5, 6].every((d) => vals.includes(d))
    if (has12345 || has23456) return { name: 'Small straight' }
    return null
  }
  const p = RARITY_PATTERNS.find((x) => x.id === sigStr)
  return p ? { name: p.name } : null
}

const COMBO_NAMES: Record<number, string> = {
  1: 'single',
  2: 'pair',
  3: 'triple',
  4: 'quad',
  5: 'five',
  6: 'six'
}

/** Compute combos from dice result (badges + rarity pattern). Matches client addHistoryEntry logic. */
export function getCombosFromDiceResult(diceResult: number[], escaped: boolean): string[] {
  const allCombos: string[] = []
  if (escaped || diceResult.length === 0) return allCombos

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  for (const v of diceResult) counts[v] = (counts[v] ?? 0) + 1

  const steps: { value: number; count: number; mult: number; combo: string }[] = []
  for (let v = 1; v <= 6; v++) {
    const n = counts[v] ?? 0
    if (n === 0) continue
    const mult = n >= 2 ? n : 1
    steps.push({ value: v, count: n, mult, combo: COMBO_NAMES[mult] ?? `×${mult}` })
  }

  const singleSteps = steps.filter((s) => s.mult === 1)
  const multiSteps = steps.filter((s) => s.mult > 1)
  if (singleSteps.length > 0) allCombos.push('single')
  for (const s of multiSteps) allCombos.push(s.combo)

  const hasSix = Object.values(counts).some((c) => c === 6)
  const sorted = [...diceResult].sort((a, b) => a - b)
  const hasLarge = diceResult.length === 6 && sorted.join('') === '123456'
  const hasSmall = ['12345', '23456'].some((s) =>
    s.split('').every((d) => (counts[+d] ?? 0) >= 1)
  )

  if (hasSix) allCombos.push('Six of a kind')
  else if (hasLarge) allCombos.push('Large straight')
  else if (hasSmall) allCombos.push('Small straight')

  const pattern = getRarityPattern(diceResult)
  if (pattern && !allCombos.includes(pattern.name)) allCombos.push(pattern.name)

  return allCombos
}

/** Six count (1–6) for sixes stats. */
export function getSixCount(diceResult: number[]): number {
  return diceResult.filter((v) => v === 6).length
}
