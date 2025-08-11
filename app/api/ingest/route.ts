export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

function authorized(req: Request) {
  const h = headers()
  const isCron = h.get('x-vercel-cron') === '1'
  const url = new URL(req.url)
  const qToken = url.searchParams.get('token')?.trim()
  const bearer = (h.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  const expected = (process.env.ADMIN_TOKEN || '').trim()
  return isCron || (!!expected && (qToken === expected || bearer === expected))
}

async function runIngest(limit?: number) {
  const mod: any = await import('@/scripts/ingest')
  if (typeof mod.run === 'function') return mod.run({ limit })
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
  // If triggered by cron and no explicit limit, cap the batch size
  const isCron = h.get('x-vercel-cron') === '1'
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
