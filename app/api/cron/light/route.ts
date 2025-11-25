// app/api/cron/light/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120 // 120 seconds for cron jobs (Pro plan)

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

type ScriptOptions = Record<string, unknown> | undefined
type ScriptRunner<R = unknown> = (options?: ScriptOptions) => Promise<R> | R
type ScriptModule<R = unknown> = { run?: ScriptRunner<R>; default?: ScriptRunner<R> }
type ScriptError = { ok: false; error: string }

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

    // Prefetch content for newly ingested articles (lighter limit)
    const prefetchResult = await safeRun(import('@/scripts/prefetch-content'), {
      limit: 20, // Smaller batch for frequent runs
      closePool: false,
    })

    // Quick rescore after new articles
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })

    // Light web discovery - smaller batch during frequent runs
    let webDiscoverResult: unknown = { skipped: 'not_run' }

    try {
      console.log('🔎 Running light web discovery...')
      webDiscoverResult = await safeRun(import('@/scripts/discover-web'), {
        outletArticleCap: 20, // Smaller cap for light runs
        outletLimitPerBatch: 6, // Fewer per batch
        outletBatchSize: 3, // Fewer outlets at a time
        outletFreshHours: 48, // Focus on more recent content
        closePool: false,
      })
      console.log('✅ Light web discovery completed')
    } catch (webError: unknown) {
      console.error('❌ Web discovery failed:', webError)
      const message = webError instanceof Error ? webError.message : String(webError)
      webDiscoverResult = {
        ok: false,
        error: message,
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
        prefetch: prefetchResult,
        rescore: rescoreResult,
        webDiscover: webDiscoverResult,
      },
    })
  } catch (err: unknown) {
    // Don't close the pool - let it be managed by the runtime
    // await endPool().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const POST = GET
