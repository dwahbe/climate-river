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

  const h = headers()
  const url = new URL(req.url)
  const q = url.searchParams.get('limit')
  const isCron = h.get('x-vercel-cron') === '1'
  const limit = q
    ? Math.max(1, Math.min(50, Number(q)))
    : isCron
      ? 25
      : undefined

  const t0 = Date.now()
  try {
    const ingestMod: any = await import('@/scripts/ingest')
    const rescoreMod: any = await import('@/scripts/rescore')

    const ingestResult =
      typeof ingestMod.run === 'function'
        ? await ingestMod.run({ limit })
        : await ingestMod.default({ limit })

    const rescoreResult =
      typeof rescoreMod.run === 'function'
        ? await rescoreMod.run({})
        : await rescoreMod.default({})

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: { ingest: ingestResult, rescore: rescoreResult },
    })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}
