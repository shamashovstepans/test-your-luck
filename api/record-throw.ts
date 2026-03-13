import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const KEY_TOTAL = 'dice:total_throws'
const KEY_COMBOS = 'dice:unique_combos'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const body = req.body as { escaped?: boolean; combo?: string }
    const escaped = body.escaped ?? false
    const combo = body.combo ?? null

    if (!redis) {
      return res.status(200).json({ ok: true, stored: false })
    }

    await redis.incr(KEY_TOTAL)

    if (!escaped && combo) {
      await redis.sadd(KEY_COMBOS, combo)
      await redis.incr(`dice:combo:${combo}`)
    }

    return res.status(200).json({ ok: true, stored: true })
  } catch (err) {
    console.error('record-throw error:', err)
    return res.status(500).json({ error: 'Failed to record throw' })
  }
}
