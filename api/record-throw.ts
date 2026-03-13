import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null

const KEY_TOTAL = 'dice:total_throws'
const KEY_COMBOS = 'dice:unique_combos'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const body = req.body as { diceResult?: number[]; escaped?: boolean; combo?: string }
    const escaped = body.escaped ?? false
    const diceResult = body.diceResult ?? []
    const combo = body.combo ?? null

    if (!redis) {
      return res.status(200).json({ ok: true, stored: false })
    }

    await redis.incr(KEY_TOTAL)

    if (!escaped && combo) {
      await redis.sadd(KEY_COMBOS, combo)
    }

    return res.status(200).json({ ok: true, stored: true })
  } catch (err) {
    console.error('record-throw error:', err)
    return res.status(500).json({ error: 'Failed to record throw' })
  }
}
