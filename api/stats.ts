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
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30')

  try {
    if (!redis) {
      return res.status(200).json({ totalThrows: 0, uniqueCombos: 0 })
    }

    const [total, combos] = await Promise.all([
      redis.get<number>(KEY_TOTAL) ?? 0,
      redis.scard(KEY_COMBOS) ?? 0,
    ])

    return res.status(200).json({
      totalThrows: typeof total === 'number' ? total : 0,
      uniqueCombos: combos,
    })
  } catch (err) {
    console.error('stats error:', err)
    return res.status(500).json({ error: 'Failed to fetch stats' })
  }
}
