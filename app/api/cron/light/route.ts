// app/api/cron/light/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // 60 seconds for cron jobs (Pro plan)

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

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
  if (!(await authorized(req))) {
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
    // Light RSS ingest
    const ingestResult = await safeRun(import('@/scripts/ingest'), {
      limit,
      closePool: false,
    })

    // Quick rescore after new articles
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })

    // Minimal breaking news discovery during peak hours (9AM-9PM)
    // Run 1 query with minimal limits to control costs
    let breakingNewsResult: any = { skipped: 'off_peak_hours' }

    try {
      const currentHour = new Date().getHours()

      if (currentHour >= 9 && currentHour <= 21) {
        console.log('🚨 Running breaking news discovery...')
        breakingNewsResult = await safeRun(import('@/scripts/discover-web'), {
          limitPerQuery: 2,
          maxQueries: 1,
          breakingNewsMode: true, // Signal to use breaking news queries
          closePool: false,
        })
      }
    } catch (webError: any) {
      console.error('❌ Breaking news discovery failed:', webError)
      breakingNewsResult = {
        ok: false,
        error: webError.message || String(webError),
        skipped: 'error',
      }
    }

    // Don't close the pool - let it be managed by the runtime
    // await endPool()

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: {
        ingest: ingestResult,
        rescore: rescoreResult,
        breakingNews: breakingNewsResult,
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
