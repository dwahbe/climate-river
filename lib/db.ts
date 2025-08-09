import { Pool } from 'pg'

let _pool: Pool | undefined

function getPool() {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      // Only complain when we actually try to query at runtime
      throw new Error('DATABASE_URL is not set')
    }
    _pool = new Pool({
      connectionString,
      max: process.env.NODE_ENV === 'production' ? 2 : 6,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { require: true } // strict in prod
          : { require: true, rejectUnauthorized: false }, // relaxed locally
    })
  }
  return _pool
}

export async function query<T = any>(text: string, params?: any[]) {
  const client = await getPool().connect()
  try {
    const res = await client.query(text, params)
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 }
  } finally {
    client.release()
  }
}

// Optional: expose pool for scripts that want to .end()
export const pool = {
  end: async () => _pool?.end(),
}
