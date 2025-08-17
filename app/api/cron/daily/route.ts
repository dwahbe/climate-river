// app/api/cron/daily/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
// import { endPool } from '@/lib/db' // Not needed anymore

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
  try {
    const mod: any = await modPromise
    const fn: any = mod?.run ?? mod?.default
    if (typeof fn !== 'function') {
      console.error('❌ Script has no run/default function export')
      return { ok: false, error: 'no_run_export' }
    }
    return await fn(opts)
  } catch (error: any) {
    console.error('❌ Script execution failed:', error)
    return { ok: false, error: error.message || String(error) }
  }
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
    Math.min(100, Number(url.searchParams.get('rewrite') || 30)) // Reduced from 120 to 30
  )

  try {
    console.log('🎯 Daily cron job starting...')

    // 1) Broader feed discovery (a bit higher than delta)
    console.log('📡 Running discover...')
    const discoverResult = await safeRun(import('@/scripts/discover'), {
      limit: discoverLimit,
      closePool: false,
    })
    console.log('✅ Discover completed:', discoverResult)

    // 2) Ingest across ALL sources (seed + discovered) with higher cap
    console.log('📥 Running ingest...')
    const ingestResult = await safeRun(import('@/scripts/ingest'), {
      limit,
      closePool: false,
    })
    console.log('✅ Ingest completed:', ingestResult)

    // 3) Rescore clusters after new data
    console.log('🔢 Running rescore...')
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })
    console.log('✅ Rescore completed:', rescoreResult)

    // 4) Rewrite more recent headlines daily (uses configured model, e.g. gpt-4o-mini)
    console.log('✏️ Running rewrite...')
    const rewriteResult = await safeRun(import('@/scripts/rewrite'), {
      limit: rewriteLimit,
      closePool: false,
    })
    console.log('✅ Rewrite completed:', rewriteResult)

    // 5) AI-enhanced web discovery (find stories beyond RSS feeds)
    // Only run at 2AM to control costs - check if this is the full daily job
    let webDiscoverResult: any = { skipped: 'time_check_failed' }

    try {
      const currentHour = new Date().getHours()
      console.log(`Current hour: ${currentHour}`)

      // Only run AI discovery during the 2AM full job (not the light business hour jobs)
      if (currentHour >= 0 && currentHour <= 6) {
        console.log('Running AI web discovery...')
        webDiscoverResult = await safeRun(import('@/scripts/discover-web'), {
          limitPerQuery: 2, // Reduced from 3
          maxQueries: 3, // Reduced from 4
          closePool: false,
        })
        console.log('AI web discovery completed')
      } else {
        console.log(`Skipping AI discovery - current hour: ${currentHour}`)
      }
    } catch (webDiscoverError: any) {
      console.error('❌ AI web discovery failed:', webDiscoverError)
      webDiscoverResult = { error: webDiscoverError.message, skipped: 'error' }
    }

    console.log('🎯 Daily cron job completed successfully!')

    // Don't close the pool - let it be managed by the runtime
    // await endPool()

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
    console.error('Daily cron job failed:', err)
    // Don't close the pool - let it be managed by the runtime
    // await endPool().catch(() => {})
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || String(err),
        stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined,
      },
      { status: 500 }
    )
  }
}

// Support POST for manual triggering
export const POST = GET
