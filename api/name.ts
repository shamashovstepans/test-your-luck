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
  const userId = getUserIdFromCookie(req)
  if (!userId) {
    return res.status(200).json({ name: '' })
  }

  try {
    if (!redis) {
      return res.status(200).json({ name: '' })
    }

    const key = `dice:user:${userId}:name`

    if (req.method === 'GET') {
      const name = await redis.get<string>(key)
      const display = (name && typeof name === 'string' ? name.trim() : '') || userId.slice(0, 6)
      return res.status(200).json({ name: name ?? '', display })
    }

    if (req.method === 'PUT') {
      const body = req.body as { name?: string }
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 32) : ''
      await redis.set(key, name || '')
      const display = name || userId.slice(0, 6)
      return res.status(200).json({ name, display })
    }

    res.setHeader('Allow', 'GET, PUT')
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('name error:', err)
    return res.status(500).json({ error: 'Failed to fetch/set name' })
  }
}
