import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const KEY_TOTAL = 'dice:total_throws'
const KEY_COMBOS = 'dice:unique_combos'

function getUserIdFromCookie(req: VercelRequest): string | null {
  const cookie = req.headers.cookie ?? req.headers['cookie']
  if (typeof cookie !== 'string') return null
  const match = cookie.match(/dice_user_id=([^;]+)/)
  return match ? decodeURIComponent(match[1].trim()) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const body = req.body as {
      escaped?: boolean
      combo?: string
      combos?: string[]
      balance?: number
      score?: number
      diceResult?: number[]
      time?: number
      seed?: number
      weight?: number
      gravity?: number
      options?: unknown
    }
    const escaped = body.escaped ?? false
    const combos = Array.isArray(body.combos) ? body.combos : (body.combo ? [body.combo] : [])
    const balance = typeof body.balance === 'number' ? body.balance : undefined
    const userId = getUserIdFromCookie(req)

    if (!redis) {
      return res.status(200).json({ ok: true, stored: false })
    }

    await redis.incr(KEY_TOTAL)

    for (const combo of combos) {
      if (combo && typeof combo === 'string') {
        await redis.sadd(KEY_COMBOS, combo)
        await redis.incr(`dice:combo:${combo}`)
      }
    }

    if (userId != null) {
      if (balance !== undefined) {
        await redis.set(`dice:user:${userId}:balance`, balance)
      }
      await redis.incr(`dice:user:${userId}:throw_count`)

      const throwRecord = JSON.stringify({
        d: body.diceResult ?? [],
        s: body.score ?? 0,
        e: escaped,
        c: combos,
        t: body.time ?? Date.now(),
        seed: body.seed ?? 0,
        w: body.weight ?? 3,
        g: body.gravity ?? 9.81,
        o: body.options ?? {}
      })
      await redis.lpush(`dice:user:${userId}:history`, throwRecord)
      await redis.ltrim(`dice:user:${userId}:history`, 0, 1999)
    }

    return res.status(200).json({ ok: true, stored: true })
  } catch (err) {
    console.error('record-throw error:', err)
    return res.status(500).json({ error: 'Failed to record throw' })
  }
}
