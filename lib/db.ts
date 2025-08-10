// lib/db.ts
import { Pool } from 'pg'

let _pool: Pool | undefined
const dev = process.env.NODE_ENV !== 'production'

function getPool(): Pool {
  if (!_pool) {
    const cs = process.env.DATABASE_URL
    if (!cs) throw new Error('DATABASE_URL is not set')
    _pool = new Pool({
      connectionString: cs,
      max: dev ? 6 : 2,
      ssl: { require: true, rejectUnauthorized: false },
    })
    // Optional: keep the process alive on idle errors
    _pool.on('error', (err) => {
      console.warn('[pg pool] idle client error:', err.message)
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

/** Only use in CLI scripts, never from API routes */
export async function endPool() {
  if (_pool) {
    try {
      await _pool.end()
    } finally {
      _pool = undefined // allow a fresh pool on next use
    }
  }
}
