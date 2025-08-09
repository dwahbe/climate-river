import { Pool } from 'pg'

// DEV: if Supabase certs trip Node locally, this prevents SSL rejection.
// Remove this line in production if you want stricter TLS.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 6,
  ssl: { require: true, rejectUnauthorized: false },
})

export async function query<T = any>(text: string, params?: any[]) {
  const client = await pool.connect()
  try {
    const res = await client.query(text, params)
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 }
  } finally {
    client.release()
  }
}
