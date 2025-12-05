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
  const timeoutMs = 280_000 // Leave 20s buffer before 5min timeout

  // Helper to check remaining time
  const hasTime = () => Date.now() - t0 < timeoutMs
  const elapsed = () => Math.round((Date.now() - t0) / 1000)

  // Conservative limits to fit within 5min
  const discoverLimit = Math.max(
    1,
    Math.min(60, Number(url.searchParams.get('discover') || 40))
  )
  const ingestLimit = Math.max(
    1,
    Math.min(100, Number(url.searchParams.get('limit') || 60))
  )
  const rewriteLimit = Math.max(
    1,
    Math.min(40, Number(url.searchParams.get('rewrite') || 20))
  )

  try {
    console.log('🎯 Full cron job starting...')

    // 1) Feed discovery - fast
    console.log('📡 Running discover...')
    const discoverResult = await safeRun(import('@/scripts/discover'), {
      limit: discoverLimit,
      closePool: false,
    })
    console.log(`✅ Discover completed (${elapsed()}s):`, discoverResult)

    // 2) Ingest articles - moderate
    console.log('📥 Running ingest...')
    const ingestResult = await safeRun(import('@/scripts/ingest'), {
      limit: ingestLimit,
      closePool: false,
    })
    console.log(`✅ Ingest completed (${elapsed()}s):`, ingestResult)

    // 3) Categorize - moderate (AI calls)
    console.log('🏷️  Running categorize...')
    const categorizeResult = await safeRun(import('@/scripts/categorize'), {
      limit: 40,
      closePool: false,
    })
    console.log(`✅ Categorize completed (${elapsed()}s):`, categorizeResult)

    // 4) Prefetch content - fast
    console.log('📖 Prefetching article content...')
    const prefetchResult = await safeRun(import('@/scripts/prefetch-content'), {
      limit: 25,
      closePool: false,
    })
    console.log(`✅ Prefetch completed (${elapsed()}s):`, prefetchResult)

    // 5) Rescore clusters - fast
    console.log('🔢 Running rescore...')
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })
    console.log(`✅ Rescore completed (${elapsed()}s):`, rescoreResult)

    // 6) WEB DISCOVERY - Run BEFORE rewrite (higher priority than rewrites)
    let webDiscoverResult: unknown = { skipped: 'timeout' }
    let prefetchDiscoveredResult: unknown = { skipped: 'not_run' }

    if (hasTime()) {
      try {
        console.log(`🔎 Running AI web discovery (${elapsed()}s elapsed)...`)
        webDiscoverResult = await safeRun(import('@/scripts/discover-web'), {
          broadArticleCap: 10,
          outletArticleCap: 20,
          outletLimitPerBatch: 6,
          outletBatchSize: 3,
          outletFreshHours: 72,
          closePool: false,
        })
        console.log(`✅ AI web discovery completed (${elapsed()}s)`)

        // Prefetch discovered articles
        if (hasTime()) {
          console.log('📖 Prefetching discovered articles...')
          prefetchDiscoveredResult = await safeRun(
            import('@/scripts/prefetch-content'),
            {
              limit: 15,
              hoursAgo: 6,
              closePool: false,
            }
          )
          console.log(`✅ Discovered prefetch completed (${elapsed()}s)`)
        }
      } catch (webErr: unknown) {
        console.error('❌ AI web discovery failed:', webErr)
        const msg = webErr instanceof Error ? webErr.message : String(webErr)
        webDiscoverResult = { error: msg, skipped: 'error' }
      }
    } else {
      console.log(`⏭️  Skipping web discovery (${elapsed()}s elapsed, timeout risk)`)
    }

    // 7) Rewrite headlines - LAST (lowest priority, can be skipped)
    let rewriteResult: unknown = { skipped: 'timeout' }

    if (hasTime()) {
      console.log(`✏️ Running rewrite (${elapsed()}s elapsed)...`)
      rewriteResult = await safeRun(import('@/scripts/rewrite'), {
        limit: rewriteLimit,
        closePool: false,
      })
      console.log(`✅ Rewrite completed (${elapsed()}s):`, rewriteResult)
    } else {
      console.log(`⏭️  Skipping rewrite (${elapsed()}s elapsed, timeout risk)`)
    }

    console.log(`🎯 Full cron job completed in ${elapsed()}s!`)

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: {
        discover: discoverResult,
        ingest: ingestResult,
        categorize: categorizeResult,
        prefetch: prefetchResult,
        rescore: rescoreResult,
        webDiscover: webDiscoverResult,
        prefetchDiscovered: prefetchDiscoveredResult,
        rewrite: rewriteResult,
      },
    })
  } catch (err: unknown) {
    console.error('Full cron job failed:', err)
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        took_ms: Date.now() - t0,
      },
      { status: 500 }
    )
  }
}

// Support POST for manual triggering
export const POST = GET
