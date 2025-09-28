// app/api/cron/light/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers, type UnsafeUnwrappedHeaders } from 'next/headers';
// import { endPool } from '@/lib/db' // Not needed anymore

function authorized(req: Request) {
  const h = (headers() as unknown as UnsafeUnwrappedHeaders)
  const url = new URL(req.url)

  const isCron =
    h.get('x-vercel-cron') === '1' ||
    /vercel-cron/i.test(h.get('user-agent') || '') ||
    url.searchParams.get('cron') === '1'

  const expected = (process.env.ADMIN_TOKEN || '').trim()
  const qToken = url.searchParams.get('token')?.trim()
  const bearer = (h.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim()

  return isCron || (!!expected && (qToken === expected || bearer === expected))
}

async function safeRun(modPromise: Promise<any>, opts?: any) {
  const mod: any = await modPromise
  const fn: any = mod?.run ?? mod?.default
  if (typeof fn !== 'function') return { ok: false, error: 'no_run_export' }
  return await fn(opts)
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  const t0 = Date.now()
  const url = new URL(req.url)

  // Light processing limits
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get('limit') || 30))
  )

  try {
    // Light RSS ingest only - no AI discovery to control costs
    const ingestResult = await safeRun(import('@/scripts/ingest'), {
      limit,
      closePool: false,
    })

    // Quick rescore after new articles
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })

    // Don't close the pool - let it be managed by the runtime
    // await endPool()

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: {
        ingest: ingestResult,
        rescore: rescoreResult,
      },
    })
  } catch (err: any) {
    // Don't close the pool - let it be managed by the runtime
    // await endPool().catch(() => {})
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    )
  }
}

export const POST = GET
