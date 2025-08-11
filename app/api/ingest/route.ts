// app/api/ingest/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

const DEFAULT_CRON_LIMIT = 25

function authorized() {
  const h = headers()
  const isCron = h.get('x-vercel-cron') === '1'
  const expected = (process.env.ADMIN_TOKEN || '').trim()

  const auth = h.get('authorization') || ''
  const bearer = auth.replace(/^Bearer\s+/i, '').trim()

  // If not a cron call, allow requests that present the admin token
  return isCron || (!!expected && bearer === expected)
}

async function runIngest(limit?: number) {
  const mod: any = await import('@/scripts/ingest')
  if (typeof mod.run === 'function') return mod.run({ limit })
  if (typeof mod.default === 'function') return mod.default({ limit })
  throw new Error('scripts/ingest.ts must export run()')
}

export async function GET(req: Request) {
  if (!authorized()) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  const h = headers()
  const isCron = h.get('x-vercel-cron') === '1'

  const url = new URL(req.url)
  const q = url.searchParams.get('limit')
  const limit = q
    ? Math.max(1, Math.min(50, Number(q)))
    : isCron
    ? DEFAULT_CRON_LIMIT
    : undefined

  const t0 = Date.now()
  try {
    const result = await runIngest(limit)
    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}

export const POST = GET
