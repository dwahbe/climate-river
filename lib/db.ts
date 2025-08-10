import 'server-only'
import { Pool } from 'pg'
import type { ConnectionOptions as TlsOptions } from 'tls'

let _pool: Pool | undefined

function getPool() {
  if (!_pool) {
    const cs = process.env.DATABASE_URL
    if (!cs) throw new Error('DATABASE_URL is not set')

    // Safe for Supabase pooled URLs; 'sslmode=require' is already in the URL.
    // We pass a permissive TLS option to avoid cert issues in serverless.
    const ssl: boolean | TlsOptions = { rejectUnauthorized: false }

    _pool = new Pool({
      connectionString: cs,
      max: process.env.NODE_ENV !== 'production' ? 6 : 2,
      ssl,
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

// for scripts
export const pool = { end: async () => _pool?.end() }
