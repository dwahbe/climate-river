// app/api/cron/daily/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes for comprehensive daily job

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

/**
 * Allow:
 *  - Vercel Cron (x-vercel-cron header or user-agent contains vercel-cron)
 *  - ADMIN_TOKEN via Bearer token or ?token=...
 *  - Optional ?cron=1 for manual tests
 */
async function authorized(req: Request) {
  const h = await headers()
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

type ScriptOptions = Record<string, unknown> | undefined
type ScriptRunner<R = unknown> = (options?: ScriptOptions) => Promise<R> | R
type ScriptModule<R = unknown> = {
  run?: ScriptRunner<R>
  default?: ScriptRunner<R>
}
type ScriptError = { ok: false; error: string }

/** Safely invoke a script module's `run` (or its default). */
async function safeRun<R = unknown>(
  modPromise: Promise<ScriptModule<R>>,
  opts?: ScriptOptions
): Promise<R | ScriptError> {
  try {
    const mod = await modPromise
    const fn = mod?.run ?? mod?.default
    if (typeof fn !== 'function') {
      console.error('❌ Script has no run/default function export')
      return { ok: false, error: 'no_run_export' }
    }
    return await fn(opts)
  } catch (error: unknown) {
    console.error('❌ Script execution failed:', error)
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
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
    Math.min(100, Number(url.searchParams.get('rewrite') || 60)) // Increased from 30 to 60
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

    // 2.25) Categorize newly ingested articles
    console.log('🏷️  Running categorize...')
    const categorizeResult = await safeRun(import('@/scripts/categorize'), {
      limit: 100, // Categorize up to 100 uncategorized articles
      closePool: false,
    })
    console.log('✅ Categorize completed:', categorizeResult)

    // 2.5) Prefetch article content for newly ingested articles
    console.log('📖 Prefetching article content...')
    const prefetchResult = await safeRun(import('@/scripts/prefetch-content'), {
      limit: 50, // Prefetch top 50 most recent articles
      closePool: false,
    })
    console.log('✅ Prefetch completed:', prefetchResult)

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
    // Run during all daily cron jobs - cost-optimized parameters
    let webDiscoverResult: unknown = { skipped: 'not_run' }

    try {
      console.log('🔎 Running AI web discovery...')
      webDiscoverResult = await safeRun(import('@/scripts/discover-web'), {
        broadArticleCap: 15, // Broad climate discovery cap
        outletArticleCap: 30, // Reduced from 50 for cost control
        outletLimitPerBatch: 8, // Reduced from 10
        outletBatchSize: 4, // Reduced from 5
        outletFreshHours: 72,
        closePool: false,
      })
      console.log('✅ AI web discovery completed')
    } catch (webDiscoverError: unknown) {
      console.error('❌ AI web discovery failed:', webDiscoverError)
      const message =
        webDiscoverError instanceof Error
          ? webDiscoverError.message
          : String(webDiscoverError)
      webDiscoverResult = { error: message, skipped: 'error' }
    }

    // 6) Prefetch content for web-discovered articles
    // This runs AFTER web discovery to ensure discovered articles get content
    console.log('📖 Prefetching content for discovered articles...')
    const prefetchDiscoveredResult = await safeRun(
      import('@/scripts/prefetch-content'),
      {
        limit: 30, // Prefetch recently discovered articles
        hoursAgo: 6, // Focus on very recent discoveries
        closePool: false,
      }
    )
    console.log('✅ Discovered article prefetch completed:', prefetchDiscoveredResult)

    console.log('🎯 Daily cron job completed successfully!')

    // Don't close the pool - let it be managed by the runtime
    // await endPool()

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: {
        discover: discoverResult,
        ingest: ingestResult,
        categorize: categorizeResult,
        prefetch: prefetchResult,
        rescore: rescoreResult,
        rewrite: rewriteResult,
        webDiscover: webDiscoverResult,
        prefetchDiscovered: prefetchDiscoveredResult,
      },
    })
  } catch (err: unknown) {
    console.error('Daily cron job failed:', err)
    // Don't close the pool - let it be managed by the runtime
    // await endPool().catch(() => {})
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        stack:
          process.env.NODE_ENV === 'development'
            ? err instanceof Error
              ? err.stack
              : undefined
            : undefined,
      },
      { status: 500 }
    )
  }
}

// Support POST for manual triggering
export const POST = GET
