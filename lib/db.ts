import { Pool } from 'pg'

let _pool: Pool | undefined
const dev = process.env.NODE_ENV !== 'production'

// Dev-only: allow self-signed/unknown CA so local works
if (dev) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

function getPool() {
  if (!_pool) {
    const cs = process.env.DATABASE_URL
    if (!cs) throw new Error('DATABASE_URL is not set')
    _pool = new Pool({
      connectionString: cs,
      max: dev ? 6 : 2,
      ssl: dev
        ? { require: true, rejectUnauthorized: false } // <-- relax in dev
        : { require: true }, // strict in prod
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

export const pool = { end: async () => _pool?.end() }
