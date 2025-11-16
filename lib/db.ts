// lib/db.ts
import { Pool, PoolConfig } from 'pg'
import type { ConnectionOptions } from 'tls'

let _pool: Pool | undefined
const isProd = process.env.NODE_ENV === 'production'

function parsePgUrl(url: string) {
  // Accept postgres:// or postgresql://
  const u = new URL(url.replace(/^postgresql:/, 'postgres:'))
  const host = u.hostname
  const port = u.port ? Number(u.port) : 5432
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(u.username || '')
  const password = decodeURIComponent(u.password || '')

  return { host, port, database, user, password, raw: url }
}

/** Build an SSL config that avoids self-signed errors in dev. */
function makeSsl(rawUrl: string, host: string): ConnectionOptions | undefined {
  const isCloud =
    /supabase\.co|supabase\.com|pooler\.supabase\.com|neon\.tech|render\.com|aws|azure|gcp/i.test(
      host
    )

  const envForcesSsl = process.env.PGSSL === '1'
  const hasSslHint =
    /\bsslmode=require\b/i.test(rawUrl) || /\bssl=true\b/i.test(rawUrl)
  const wantsSSL = isCloud || envForcesSsl || hasSslHint

  if (!wantsSSL) return undefined

  // In dev (or if explicitly disabled), don't verify CA chain
  const noVerify = !isProd || process.env.PGSSL_NO_VERIFY === '1'
  return { rejectUnauthorized: !noVerify }
}

function getPool() {
  if (_pool) return _pool

  const cs =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_CONNECTION_STRING

  if (!cs) {
    throw new Error(
      'DATABASE_URL is not set. Put your Supabase/Postgres URI in .env.local (dev) or your hosting env.'
    )
  }

  const { host, port, database, user, password, raw } = parsePgUrl(cs)
  const ssl = makeSsl(raw, host)

  // IMPORTANT: pass discrete fields, not connectionString,
  // so pg won’t re-parse ?sslmode=require and override our ssl object.
  const cfg: PoolConfig = {
    host,
    port,
    database,
    user,
    password,
    ssl,
    max: isProd ? 4 : 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  }

  _pool = new Pool(cfg)

  _pool.on('error', (err) => {
    console.error('pg pool error:', err)
  })

  return _pool
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: ReadonlyArray<unknown>
) {
  const client = await getPool().connect()
  try {
    const res = params
      ? await client.query(text, params as any[])
      : await client.query(text)
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
