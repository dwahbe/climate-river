// app/api/ingest/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

/** Allow either: Vercel Cron, ?cron=1, or a valid ADMIN_TOKEN (query or Bearer). */
function authorized(req: Request) {
  const h = headers()
  const url = new URL(req.url)

  const isCron =
    h.get('x-vercel-cron') === '1' || // normal Vercel Cron header
    /vercel-cron/i.test(h.get('user-agent') || '') || // fallback via UA
    url.searchParams.get('cron') === '1' // explicit flag we add in vercel.json

  const qToken = url.searchParams.get('token')?.trim()
  const bearer = (h.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  const expected = (process.env.ADMIN_TOKEN || '').trim()

  return isCron || (!!expected && (qToken === expected || bearer === expected))
}

async function runIngest(limit?: number) {
  // scripts/ingest exports run(opts). We keep it typed as any to avoid coupling.
  const mod: any = await import('@/scripts/ingest')
  if (typeof mod.run === 'function') return mod.run({ limit }) // serverless: do NOT pass closePool
  if (typeof mod.default === 'function') return mod.default({ limit })
  throw new Error('scripts/ingest.ts must export run()')
}

export async function GET(req: Request) {
  const h = headers()
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  const url = new URL(req.url)
  const q = url.searchParams.get('limit')
  const isCron =
    h.get('x-vercel-cron') === '1' ||
    /vercel-cron/i.test(h.get('user-agent') || '') ||
    url.searchParams.get('cron') === '1'
  const limit = q
    ? Math.max(1, Math.min(50, Number(q)))
    : isCron
    ? 25
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
