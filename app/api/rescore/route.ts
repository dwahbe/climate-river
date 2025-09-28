// app/api/rescore/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers, type UnsafeUnwrappedHeaders } from 'next/headers';

/** Same auth policy as /api/ingest */
function authorized(req: Request) {
  const h = (headers() as unknown as UnsafeUnwrappedHeaders)
  const url = new URL(req.url)

  const isCron =
    h.get('x-vercel-cron') === '1' ||
    /vercel-cron/i.test(h.get('user-agent') || '') ||
    url.searchParams.get('cron') === '1'

  const qToken = url.searchParams.get('token')?.trim()
  const bearer = (h.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  const expected = (process.env.ADMIN_TOKEN || '').trim()

  return isCron || (!!expected && (qToken === expected || bearer === expected))
}

async function runRescore() {
  const mod: any = await import('@/scripts/rescore')
  if (typeof mod.run === 'function') return mod.run({})
  if (typeof mod.default === 'function') return mod.default({})
  throw new Error('scripts/rescore.ts must export run()')
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  const t0 = Date.now()
  try {
    const result = await runRescore()
    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}

export const POST = GET
