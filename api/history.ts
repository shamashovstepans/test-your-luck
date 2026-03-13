import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Redis } from '@upstash/redis'

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

function getUserIdFromCookie(req: VercelRequest): string | null {
  const cookie = req.headers.cookie ?? req.headers['cookie']
  if (typeof cookie !== 'string') return null
  const match = cookie.match(/dice_user_id=([^;]+)/)
  return match ? decodeURIComponent(match[1].trim()) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const userId = getUserIdFromCookie(req)
  if (!userId) {
    return res.status(200).json({ history: [], throwCount: 0 })
  }

  try {
    if (!redis) {
      return res.status(200).json({ history: [], throwCount: 0 })
    }

    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50))
    const offset = Math.max(0, Number(req.query?.offset) || 0)

    const [rawList, throwCount] = await Promise.all([
      redis.lrange(`dice:user:${userId}:history`, offset, offset + limit - 1),
      redis.get<number>(`dice:user:${userId}:throw_count`)
    ])

    const history = (rawList ?? []).map((s) => {
      try {
        const o = JSON.parse(s as string) as { d?: number[]; s?: number; e?: boolean; c?: string[]; t?: number; seed?: number; w?: number; g?: number; o?: unknown }
        return {
          diceResult: o.d ?? [],
          score: o.s ?? 0,
          escaped: o.e ?? false,
          combos: o.c ?? [],
          time: o.t ?? 0,
          seed: o.seed ?? 0,
          weight: o.w ?? 3,
          gravity: o.g ?? 9.81,
          options: o.o ?? {}
        }
      } catch {
        return null
      }
    }).filter(Boolean)

    return res.status(200).json({
      history,
      throwCount: Math.max(0, Number(throwCount) || 0)
    })
  } catch (err) {
    console.error('history error:', err)
    return res.status(500).json({ error: 'Failed to fetch history' })
  }
}
