import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const KEY_LEADERBOARD = 'dice:leaderboard:throws'

function displayName(name: string | null, userId: string): string {
  return (name && name.trim()) ? name.trim() : userId.slice(0, 6)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30')

  try {
    if (!redis) {
      return res.status(200).json({ leaderboard: [] })
    }

    const limit = Math.min(20, Math.max(1, Number(req.query?.limit) || 10))
    const raw = (await redis.zrange(KEY_LEADERBOARD, 0, limit - 1, { rev: true, withScores: true })) ?? []
    const entries: [string, number][] = []
    for (let i = 0; i < raw.length; i += 2) {
      entries.push([String(raw[i]), Number(raw[i + 1]) || 0])
    }

    const userIds = entries.map(([id]) => id)
    const names = userIds.length > 0
      ? await redis.mget<string>(...userIds.map((id) => `dice:user:${id}:name`))
      : []

    const leaderboard = entries.map(([userId, score], i) => ({
      rank: i + 1,
      userId,
      name: displayName(names[i] ?? null, userId),
      throws: Math.round(Number(score) || 0)
    }))

    return res.status(200).json({ leaderboard })
  } catch (err) {
    console.error('leaderboard error:', err)
    return res.status(500).json({ error: 'Failed to fetch leaderboard' })
  }
}
