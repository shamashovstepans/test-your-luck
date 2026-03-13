import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const KEY_TOTAL = 'dice:total_throws'
const KEY_COMBOS = 'dice:unique_combos'
const MAX_BATCH = 500

function getUserIdFromCookie(req: VercelRequest): string | null {
  const cookie = req.headers.cookie ?? req.headers['cookie']
  if (typeof cookie !== 'string') return null
  const match = cookie.match(/dice_user_id=([^;]+)/)
  return match ? decodeURIComponent(match[1].trim()) : null
}

type ThrowItem = {
  diceResult?: number[]
  escaped?: boolean
  combos?: string[]
  score?: number
  balance?: number
  time?: number
  seed?: number
  weight?: number
  gravity?: number
  options?: unknown
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const body = req.body as { throws?: ThrowItem[] }
    const items = Array.isArray(body.throws) ? body.throws.slice(0, MAX_BATCH) : []

    if (items.length === 0) {
      return res.status(200).json({ ok: true, stored: 0 })
    }

    const userId = getUserIdFromCookie(req)

    if (!redis) {
      return res.status(200).json({ ok: true, stored: 0 })
    }

    let balance = 0
    const pipeline = redis.pipeline()

    for (const t of items) {
      const diceResult = t.diceResult ?? []
      const escaped = t.escaped ?? false
      const combos = Array.isArray(t.combos) ? t.combos : []
      const score = t.score ?? 0

      pipeline.incr(KEY_TOTAL)

      const sixCount = diceResult.filter((v) => v === 6).length
      if (sixCount >= 1 && sixCount <= 6) {
        pipeline.incr(`dice:sixes:${sixCount}`)
      }

      for (const combo of combos) {
        if (combo && typeof combo === 'string') {
          pipeline.sadd(KEY_COMBOS, combo)
          pipeline.incr(`dice:combo:${combo}`)
        }
      }

      if (userId != null) {
        balance += score
        pipeline.incr(`dice:user:${userId}:throw_count`)
      }
    }

    await pipeline.exec()

    if (userId != null && items.length > 0) {
      const lastBalance = typeof items[items.length - 1].balance === 'number'
        ? items[items.length - 1].balance
        : undefined
      if (lastBalance !== undefined) {
        await redis.set(`dice:user:${userId}:balance`, lastBalance)
      }
    }

    return res.status(200).json({ ok: true, stored: items.length })
  } catch (err) {
    console.error('record-throws error:', err)
    return res.status(500).json({ error: 'Failed to record throws' })
  }
}
