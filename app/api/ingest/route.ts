// app/api/ingest/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

function authorized(req: Request) {
  const h = headers()
  const isCron = h.get('x-vercel-cron') === '1'

  const url = new URL(req.url)
  const qToken = url.searchParams.get('token')?.trim()

  const auth = h.get('authorization') || ''
  const bearer = auth.replace(/^Bearer\s+/i, '').trim()

  const expected = (process.env.ADMIN_TOKEN || '').trim()
  return isCron || (!!expected && (qToken === expected || bearer === expected))
}

async function runIngest(limit?: number) {
  // Optional: allow a small batch to avoid function timeouts
  try {
    const mod: any = await import('@/scripts/ingest')
    if (typeof mod.run === 'function') {
      // If your ingest supports a limit parameter, pass it; otherwise just call run()
      return await mod.run({ limit })
    }
    // Fallback to default export
    if (typeof mod.default === 'function') {
      return await mod.default({ limit })
    }
    throw new Error('scripts/ingest.ts must export run()')
  } catch (e) {
    throw e
  }
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }
  const url = new URL(req.url)
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam
    ? Math.max(1, Math.min(50, Number(limitParam)))
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

export async function GET(req: Request) {
  return handle(req)
}
export async function POST(req: Request) {
  return handle(req)
}
