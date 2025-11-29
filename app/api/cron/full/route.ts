// app/api/cron/full/route.ts
// Full pipeline cron - runs 3×/day for comprehensive processing
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes for comprehensive job

import { NextResponse } from 'next/server'
import { authorized, safeRun } from '@/lib/cron'

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  const t0 = Date.now()
  const url = new URL(req.url)

  // Heavier defaults for the full job (override with ?limit=...)
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
    Math.min(100, Number(url.searchParams.get('rewrite') || 60))
  )

  try {
    console.log('🎯 Full cron job starting...')

    // 1) Broader feed discovery
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

    // 3) Categorize newly ingested articles
    console.log('🏷️  Running categorize...')
    const categorizeResult = await safeRun(import('@/scripts/categorize'), {
      limit: 100,
      closePool: false,
    })
    console.log('✅ Categorize completed:', categorizeResult)

    // 4) Prefetch article content for newly ingested articles
    console.log('📖 Prefetching article content...')
    const prefetchResult = await safeRun(import('@/scripts/prefetch-content'), {
      limit: 50,
      closePool: false,
    })
    console.log('✅ Prefetch completed:', prefetchResult)

    // 5) Rescore clusters after new data
    console.log('🔢 Running rescore...')
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })
    console.log('✅ Rescore completed:', rescoreResult)

    // 6) Rewrite recent headlines (uses configured model, e.g. gpt-4o-mini)
    console.log('✏️ Running rewrite...')
    const rewriteResult = await safeRun(import('@/scripts/rewrite'), {
      limit: rewriteLimit,
      closePool: false,
    })
    console.log('✅ Rewrite completed:', rewriteResult)

    // 7) AI-enhanced web discovery (find stories beyond RSS feeds)
    let webDiscoverResult: unknown = { skipped: 'not_run' }

    try {
      console.log('🔎 Running AI web discovery...')
      webDiscoverResult = await safeRun(import('@/scripts/discover-web'), {
        broadArticleCap: 15,
        outletArticleCap: 30,
        outletLimitPerBatch: 8,
        outletBatchSize: 4,
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

    // 8) Prefetch content for web-discovered articles
    console.log('📖 Prefetching content for discovered articles...')
    const prefetchDiscoveredResult = await safeRun(
      import('@/scripts/prefetch-content'),
      {
        limit: 30,
        hoursAgo: 6,
        closePool: false,
      }
    )
    console.log('✅ Discovered article prefetch completed:', prefetchDiscoveredResult)

    console.log('🎯 Full cron job completed successfully!')

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
    console.error('Full cron job failed:', err)
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

