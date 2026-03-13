import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

const COOKIE_NAME = 'dice_user_id'

function getUserIdFromCookie(req: VercelRequest): string | null {
  const cookie = req.headers.cookie ?? req.headers['cookie']
  if (typeof cookie !== 'string') return null
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match ? decodeURIComponent(match[1].trim()) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = getUserIdFromCookie(req)
  if (!userId) {
    return res.status(200).json({ balance: 0, throwCount: 0 })
  }

  try {
    if (!redis) {
      return res.status(200).json({ balance: 0, throwCount: 0 })
    }

    const key = `dice:user:${userId}:balance`

    if (req.method === 'GET') {
      const [balanceVal, throwCountVal] = await Promise.all([
        redis.get(key),
        redis.get(`dice:user:${userId}:throw_count`)
      ])
      const balance = Math.max(0, Number(balanceVal) || 0)
      const throwCount = Math.max(0, Number(throwCountVal) || 0)
      return res.status(200).json({ balance, throwCount })
    }

    if (req.method === 'PUT') {
      const body = req.body as { balance?: number }
      const balance = Math.max(0, Math.floor(Number(body?.balance) || 0))
      await redis.set(key, balance)
      const throwCountVal = await redis.get(`dice:user:${userId}:throw_count`)
      const throwCount = Math.max(0, Number(throwCountVal) || 0)
      return res.status(200).json({ balance, throwCount })
    }

    res.setHeader('Allow', 'GET, PUT')
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('balance error:', err)
    return res.status(500).json({ error: 'Failed to fetch balance' })
  }
}
