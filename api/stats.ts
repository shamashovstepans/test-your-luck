import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const KEY_TOTAL = 'dice:total_throws'
const KEY_COMBOS = 'dice:unique_combos'

const COMBO_NAMES = [
  'Six of a kind', 'Five of a kind', 'Four + pair', 'Four of a kind',
  'Three + pair', 'Three of a kind', 'Three pairs', 'Two pairs',
  'Large straight', 'Small straight',
  'single', 'pair', 'triple', 'quad', 'five', 'six'
]

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30')

  const debug = ['1', 'true'].includes(String(req.query?.debug ?? '').toLowerCase())

  try {
    if (!redis) {
      const empty = { totalThrows: 0, uniqueCombos: 0, combos: {} as Record<string, number>, sixes: { '6': 0, '66': 0, '666': 0, '6666': 0, '66666': 0, '666666': 0 }, comboLeaders: {} as Record<string, { name: string; count: number }> }
      return res.status(200).json(
        debug ? { ...empty, redisConnected: false } : empty
      )
    }

    const total = await redis.get(KEY_TOTAL)
    const totalThrows = Math.max(0, Number(total) || 0)

    const [comboCounts, sixCounts, comboLeadersRaw] = await Promise.all([
      Promise.all(COMBO_NAMES.map((name) => redis.get(`dice:combo:${name}`))),
      Promise.all([1, 2, 3, 4, 5, 6].map((n) => redis.get(`dice:sixes:${n}`))),
      Promise.all(COMBO_NAMES.map((name) => redis.zrange(`dice:combo:${name}:users`, 0, 0, { rev: true, withScores: true })))
    ])
    const combos: Record<string, number> = {}
    COMBO_NAMES.forEach((name, i) => {
      combos[name] = Math.max(0, Number(comboCounts[i]) || 0)
    })
    const sixes: Record<string, number> = {}
    ;['6', '66', '666', '6666', '66666', '666666'].forEach((label, i) => {
      sixes[label] = Math.max(0, Number(sixCounts[i]) || 0)
    })
    const uniqueCombos = Object.values(combos).filter((c) => c > 0).length

    const topUserIds: string[] = []
    const topCounts: number[] = []
    for (const raw of comboLeadersRaw ?? []) {
      const arr = Array.isArray(raw) ? raw : []
      const member = arr[0]
      const score = arr[1]
      if (member != null && (score != null || score === 0)) {
        topUserIds.push(String(member))
        topCounts.push(Math.round(Number(score) || 0))
      } else {
        topUserIds.push('')
        topCounts.push(0)
      }
    }
    const names = topUserIds.length > 0
      ? await redis.mget<string>(...topUserIds.filter(Boolean).map((id) => `dice:user:${id}:name`))
      : []
    const nameMap = new Map<string, string>()
    let nameIdx = 0
    for (const uid of topUserIds) {
      if (uid) {
        const n = names[nameIdx++] ?? null
        nameMap.set(uid, (n && typeof n === 'string' ? n.trim() : '') || uid.slice(0, 6))
      }
    }
    const comboLeaders: Record<string, { name: string; count: number }> = {}
    COMBO_NAMES.forEach((name, i) => {
      const uid = topUserIds[i]
      const count = topCounts[i] ?? 0
      if (uid && count > 0) {
        comboLeaders[name] = { name: nameMap.get(uid) ?? uid.slice(0, 6), count }
      }
    })

    return res.status(200).json(
      debug
        ? { totalThrows, uniqueCombos, combos, sixes, comboLeaders, redisConnected: true }
        : { totalThrows, uniqueCombos, combos, sixes, comboLeaders }
    )
  } catch (err) {
    console.error('stats error:', err)
    return res.status(500).json({ error: 'Failed to fetch stats' })
  }
}
