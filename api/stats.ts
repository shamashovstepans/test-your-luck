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
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30')

  const debug = ['1', 'true'].includes(String(req.query?.debug ?? '').toLowerCase())

  try {
    if (!redis) {
      return res.status(200).json(
        debug
          ? { totalThrows: 0, uniqueCombos: 0, redisConnected: false }
          : { totalThrows: 0, uniqueCombos: 0 }
      )
    }

    const [total, combos] = await Promise.all([
      redis.get(KEY_TOTAL),
      redis.scard(KEY_COMBOS),
    ])

    const totalThrows = Math.max(0, Number(total) || 0)
    const uniqueCombos = Math.max(0, Number(combos) || 0)

    return res.status(200).json(
      debug
        ? { totalThrows, uniqueCombos, redisConnected: true }
        : { totalThrows, uniqueCombos }
    )
  } catch (err) {
    console.error('stats error:', err)
    return res.status(500).json({ error: 'Failed to fetch stats' })
  }
}
