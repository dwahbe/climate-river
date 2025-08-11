// app/api/cron/daily/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

function authorized(req: Request) {
  const h = headers()
  const isCron =
    h.get('x-vercel-cron') === '1' ||
    /vercel-cron/i.test(h.get('user-agent') || '') ||
    new URL(req.url).searchParams.get('cron') === '1'

  const bearer = (h.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  const qToken = new URL(req.url).searchParams.get('token')?.trim()
  const expected = (process.env.ADMIN_TOKEN || '').trim()

  return isCron || (!!expected && (bearer === expected || qToken === expected))
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
    const ingest: any = await import('@/scripts/ingest')
    const rewrite: any = await import('@/scripts/rewrite')
    const rescore: any = await import('@/scripts/rescore')

    // Daily: full pass, then rescore (sequential)
    const ing =
      typeof ingest.run === 'function'
        ? await ingest.run({})
        : await ingest.default?.({})
    const rew =
      typeof rewrite.run === 'function'
        ? await rewrite.run({ limit: 200 })
        : await rewrite.default?.({ limit: 200 })
    const sco =
      typeof rescore.run === 'function'
        ? await rescore.run({})
        : await rescore.default?.({})

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: { ingest: ing, rewrite: rew, rescore: sco },
    })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}

export const POST = GET
