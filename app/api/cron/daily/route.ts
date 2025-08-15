// app/api/cron/daily/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { endPool } from '@/lib/db'

/**
 * Allow:
 *  - Vercel Cron (x-vercel-cron header or user-agent contains vercel-cron)
 *  - ADMIN_TOKEN via Bearer token or ?token=...
 *  - Optional ?cron=1 for manual tests
 */
function authorized(req: Request) {
  const h = headers()
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

/** Safely invoke a script module's `run` (or its default). */
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

  // Heavier defaults for the daily job (override with ?limit=...)
  const limit = Math.max(
    1,
    Math.min(500, Number(url.searchParams.get('limit') || 150))
  )
  const discoverLimit = Math.max(
    1,
    Math.min(200, Number(url.searchParams.get('discover') || 60))
  )
  const rewriteLimit = Math.max(
    1,
    Math.min(400, Number(url.searchParams.get('rewrite') || 120))
  )

  try {
    // 1) Broader feed discovery (a bit higher than delta)
    const discoverResult = await safeRun(import('@/scripts/discover'), {
      limit: discoverLimit,
      closePool: false,
    })

    // 2) Ingest across ALL sources (seed + discovered) with higher cap
    const ingestResult = await safeRun(import('@/scripts/ingest'), {
      limit,
      closePool: false,
    })

    // 3) Rescore clusters after new data
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })

    // 4) Rewrite more recent headlines daily (uses configured model, e.g. gpt-4o-mini)
    const rewriteResult = await safeRun(import('@/scripts/rewrite'), {
      limit: rewriteLimit,
      closePool: false,
    })

    // 5) AI-enhanced web discovery (find stories beyond RSS feeds)
    const webDiscoverResult = await safeRun(import('@/scripts/discover-web'), {
      limitPerQuery: 3,
      maxQueries: 4,
      closePool: false,
    })

    await endPool()

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: {
        discover: discoverResult,
        ingest: ingestResult,
        rescore: rescoreResult,
        rewrite: rewriteResult,
        webDiscover: webDiscoverResult,
      },
    })
  } catch (err: any) {
    await endPool().catch(() => {})
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    )
  }
}

// Support POST for manual triggering
export const POST = GET
