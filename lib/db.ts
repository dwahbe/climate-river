// lib/db.ts
import { Pool } from 'pg'
import type { ConnectionOptions } from 'tls'

let _pool: Pool | undefined
const dev = process.env.NODE_ENV !== 'production'

function getPool() {
  if (!_pool) {
    const cs = process.env.DATABASE_URL
    if (!cs) throw new Error('DATABASE_URL is not set')

    // For Supabase / hosted Postgres with SSL; no 'require' key here.
    const ssl: boolean | ConnectionOptions = { rejectUnauthorized: false }

    _pool = new Pool({
      connectionString: cs,
      max: dev ? 6 : 2,
      ssl,
    })

    // Optional: surface pool errors instead of crashing silently
    _pool.on('error', (err) => {
      console.error('pg pool error:', err)
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

/** Allow CLI scripts to close the pool; do NOT call from API routes. */
export async function endPool() {
  if (_pool) {
    await _pool.end()
    _pool = undefined
  }
}
