import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

// Inlined from scoring-utils to avoid ESM module resolution issues on Vercel
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
const COMBO_NAMES: Record<number, string> = {
  1: 'single',
  2: 'pair',
  3: 'triple',
  4: 'quad',
  5: 'five',
  6: 'six'
}

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

function getCombosFromDiceResult(diceResult: number[], escaped: boolean): string[] {
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

function getSixCount(diceResult: number[]): number {
  return diceResult.filter((v) => v === 6).length
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const KEY_TOTAL = 'dice:total_throws'
const KEY_COMBOS = 'dice:unique_combos'
const KEY_LEADERBOARD = 'dice:leaderboard:throws'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const secret = process.env.RECALCULATE_SECRET
  if (secret && req.headers['x-recalculate-key'] !== secret && req.query?.key !== secret) {
    return res.status(403).json({ error: 'Unauthorized' })
  }

  if (!redis) {
    return res.status(200).json({ ok: false, error: 'Redis not configured' })
  }

  try {
    const historyKeys: string[] = []
    let cursor = 0
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: 'dice:user:*:history', count: 100 })
      cursor = nextCursor
      historyKeys.push(...(keys as string[]))
    } while (cursor !== 0)

    let totalThrows = 0
    const sixes: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
    const combos: Record<string, number> = {}
    const uniqueCombos = new Set<string>()
    const userThrows: Record<string, number> = {}
    const userComboCounts: Record<string, Record<string, number>> = {}

    for (const key of historyKeys) {
      const userId = key.replace(/^dice:user:(.+):history$/, '$1')
      const rawList = await redis.lrange(key, 0, -1)
      const count = (rawList ?? []).length
      if (userId && count > 0) userThrows[userId] = (userThrows[userId] ?? 0) + count
      for (const s of rawList ?? []) {
        try {
          const o = JSON.parse(s as string) as { d?: number[]; e?: boolean }
          const diceResult = o.d ?? []
          const escaped = o.e ?? false

          totalThrows++

          const sixCount = getSixCount(diceResult)
          if (sixCount >= 1 && sixCount <= 6) sixes[sixCount]++

          const comboList = getCombosFromDiceResult(diceResult, escaped)
          for (const c of comboList) {
            if (c) {
              combos[c] = (combos[c] ?? 0) + 1
              uniqueCombos.add(c)
              if (userId) {
                if (!userComboCounts[userId]) userComboCounts[userId] = {}
                userComboCounts[userId][c] = (userComboCounts[userId][c] ?? 0) + 1
              }
            }
          }
        } catch {
          // skip malformed records
        }
      }
    }

    const pipeline = redis.pipeline()

    pipeline.set(KEY_TOTAL, totalThrows)
    for (let n = 1; n <= 6; n++) {
      pipeline.set(`dice:sixes:${n}`, sixes[n])
    }

    const comboKeys: string[] = []
    let comboCursor = 0
    do {
      const [nextCursor, keys] = await redis.scan(comboCursor, { match: 'dice:combo:*', count: 100 })
      comboCursor = nextCursor
      comboKeys.push(...(keys as string[]))
    } while (comboCursor !== 0)
    if (comboKeys.length > 0) pipeline.del(...comboKeys)

    pipeline.del(KEY_COMBOS)
    for (const c of uniqueCombos) pipeline.sadd(KEY_COMBOS, c)
    for (const [name, count] of Object.entries(combos)) {
      pipeline.set(`dice:combo:${name}`, count)
    }

    pipeline.del(KEY_LEADERBOARD)
    for (const [uid, count] of Object.entries(userThrows)) {
      if (count > 0) pipeline.zadd(KEY_LEADERBOARD, { score: count, member: uid })
    }

    for (const [comboName, _] of Object.entries(combos)) {
      pipeline.del(`dice:combo:${comboName}:users`)
    }
    for (const [uid, comboCounts] of Object.entries(userComboCounts)) {
      for (const [comboName, count] of Object.entries(comboCounts)) {
        if (count > 0) pipeline.zadd(`dice:combo:${comboName}:users`, { score: count, member: uid })
      }
    }

    await pipeline.exec()

    const comboLeadersCount = Object.values(userComboCounts).reduce((sum, m) => sum + Object.keys(m).length, 0)
    return res.status(200).json({
      ok: true,
      totalThrows,
      sixes: {
        '6': sixes[1],
        '66': sixes[2],
        '666': sixes[3],
        '6666': sixes[4],
        '66666': sixes[5],
        '666666': sixes[6]
      },
      uniqueCombos: uniqueCombos.size,
      usersProcessed: historyKeys.length,
      comboLeaderEntriesRebuilt: comboLeadersCount
    })
  } catch (err) {
    console.error('recalculate-stats error:', err)
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
