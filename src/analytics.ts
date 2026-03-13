/**
 * Global throw analytics - reports throws to Firebase and subscribes to live stats.
 * Configure via env: VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_DATABASE_URL
 * If not configured, reporting and subscription are no-ops.
 */

export type GlobalStats = {
  totalThrows: number
  combinations: Record<string, number>
}

type StatsCallback = (stats: GlobalStats) => void

let dbInstance: { ref: (path: string) => unknown; runTransaction: (r: unknown, fn: (v: number | null) => number) => Promise<unknown>; onValue: (r: unknown, cb: (s: { val: () => unknown }) => void) => () => void } | null = null
let unsubscribe: (() => void) | null = null

function getConfig() {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL
  if (!apiKey || !projectId || !databaseURL) return null
  return { apiKey, projectId, databaseURL }
}

async function getDb() {
  if (dbInstance) return dbInstance
  const config = getConfig()
  if (!config) return null
  try {
    const [{ initializeApp }, { getDatabase, ref, runTransaction, onValue }] = await Promise.all([
      import('firebase/app'),
      import('firebase/database')
    ])
    const app = initializeApp({
      apiKey: config.apiKey,
      projectId: config.projectId,
      databaseURL: config.databaseURL
    })
    const database = getDatabase(app)
    dbInstance = {
      ref: (path: string) => ref(database, path),
      runTransaction: (r, fn) => runTransaction(r as ReturnType<typeof ref>, fn),
      onValue: (r, cb) => onValue(r as ReturnType<typeof ref>, cb)
    }
    return dbInstance
  } catch (err) {
    console.warn('Analytics: Firebase init failed', err)
    return null
  }
}

/** Report a throw to global analytics. Pattern can be null for escaped throws. */
export async function reportThrow(patternName: string | null): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const totalRef = db.ref('analytics/totalThrows')
    await db.runTransaction(totalRef, (v) => (v ?? 0) + 1)
    if (patternName) {
      const comboRef = db.ref(`analytics/combinations/${patternName}`)
      await db.runTransaction(comboRef, (v) => (v ?? 0) + 1)
    }
  } catch (err) {
    console.warn('Analytics: report failed', err)
  }
}

/** Subscribe to global stats. Returns unsubscribe function. */
export function subscribeToGlobalStats(callback: StatsCallback): () => void {
  if (unsubscribe) unsubscribe()
  const config = getConfig()
  if (!config) {
    callback({ totalThrows: 0, combinations: {} })
    return () => {}
  }
  getDb().then((db) => {
    if (!db) {
      callback({ totalThrows: 0, combinations: {} })
      return
    }
    const statsRef = db.ref('analytics')
    unsubscribe = db.onValue(statsRef, (snapshot) => {
      const data = (snapshot as { val: () => unknown }).val() as { totalThrows?: number; combinations?: Record<string, number> } | null
      callback({
        totalThrows: data?.totalThrows ?? 0,
        combinations: data?.combinations ?? {}
      })
    })
  })
  return () => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}
