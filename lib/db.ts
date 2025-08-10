// lib/db.ts
import 'server-only'
import { Pool } from 'pg'

let _pool: Pool | undefined
const dev = process.env.NODE_ENV !== 'production'

/** Try to discover the Supabase project ref from envs. */
function getProjectRef(): string | null {
  const fromExplicit = process.env.SUPABASE_PROJECT_REF?.trim()
  if (fromExplicit) return fromExplicit

  // Common envs people already have with Supabase
  const fromPublicUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''

  const m1 = fromPublicUrl.match(/^https?:\/\/([a-z0-9]{15,})\.supabase\.co/i)
  if (m1) return m1[1]

  // If DATABASE_URL is the *direct* form (db.<ref>.supabase.co), extract ref
  const raw = process.env.DATABASE_URL || ''
  try {
    const u = new URL(raw)
    const m2 = u.hostname.match(/^db\.([a-z0-9]{15,})\.supabase\.co$/i)
    if (m2) return m2[1]
  } catch {
    /* ignore */
  }

  return null
}

/** Normalize the DATABASE_URL (protocol, sslmode, pooler options, etc.) */
function normalizeDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL?.trim()
  if (!raw) throw new Error('DATABASE_URL is not set')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }

  // Accept postgres:// or postgresql://; normalize to postgresql://
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    url.protocol = 'postgresql:'
  }

  // Always require TLS
  const qp = url.searchParams
  if (!qp.has('sslmode')) qp.set('sslmode', 'require')

  // Supabase pooler (Supavisor) requires the project ref:
  //   options=project%3D<PROJECT_REF>
  if (url.hostname.includes('pooler.supabase.com')) {
    const hasProject = (qp.get('options') || '').includes('project=')

    if (!hasProject) {
      const ref = getProjectRef()
      if (ref) {
        // Set encoded: "project=<ref>" -> project%3D<ref>
        qp.set('options', `project%3D${encodeURIComponent(ref)}`)
      } else {
        // Helpful error before pg throws "Tenant or user not found"
        throw new Error(
          'Supabase pooler URL detected but no project ref provided. ' +
            'Add &options=project%3D<PROJECT_REF> to DATABASE_URL or set SUPABASE_PROJECT_REF in .env.local.'
        )
      }
    }
  }

  return url.toString()
}

function getPool() {
  if (!_pool) {
    const cs = normalizeDatabaseUrl()
    if (dev) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // dev-only: relax TLS

    _pool = new Pool({
      connectionString: cs,
      max: dev ? 6 : 2,
      ssl: { require: true, rejectUnauthorized: false },
    })
  }
  return _pool
}

export async function query<T = any>(text: string, params?: any[]) {
  const client = await getPool().connect()
  try {
    const res = await client.query(text, params)
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 }
  } catch (err: any) {
    const msg = String(err?.message || err)
    const host = (() => {
      try {
        return new URL(process.env.DATABASE_URL || '').host
      } catch {
        return ''
      }
    })()

    if (/ENOTFOUND/i.test(msg)) {
      throw new Error(
        `Could not resolve database host "${host}". ` +
          `Check DATABASE_URL (typos, quotes, line breaks) and your DNS/VPN.`
      )
    }
    if (/Tenant or user not found/i.test(msg)) {
      throw new Error(
        'Supabase pooler error: set SUPABASE_PROJECT_REF in .env.local ' +
          'or add &options=project%3D<PROJECT_REF> to DATABASE_URL.'
      )
    }
    throw err
  } finally {
    client.release()
  }
}

export const pool = { end: async () => _pool?.end() }
