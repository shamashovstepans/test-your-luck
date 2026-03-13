import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'
import { getCombosFromDiceResult, getSixCount } from './scoring-utils'

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

    await pipeline.exec()

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
      usersProcessed: historyKeys.length
    })
  } catch (err) {
    console.error('recalculate-stats error:', err)
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
