// app/api/cron/delta/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { endPool } from '@/lib/db'

/**
 * Allow:
 *  - Vercel Cron (x-vercel-cron header, or user-agent contains vercel-cron)
 *  - ADMIN_TOKEN via Bearer token or ?token=... query param
 *  - Optional ?cron=1 for manual testing
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

/**
 * Safely call a script's `run` (or `default`) regardless of its TypeScript signature.
 * Extra options are harmless if the function ignores them.
 */
async function safeRun(modPromise: Promise<any>, opts?: any) {
  const mod: any = await modPromise
  const fn: any = mod?.run ?? mod?.default
  if (typeof fn !== 'function') return { ok: false, error: 'no_run_export' }
  return await fn(opts)
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
  // limit controls how many items each step *tries* to process
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get('limit') || 25))
  )

  try {
    // 1) Discover new feeds/domains (lightweight enrich step)
    const discoverResult = await safeRun(import('@/scripts/discover'), {
      limit,
      closePool: false,
    })

    // 2) Ingest from all sources (seed + discovered)
    const ingestResult = await safeRun(import('@/scripts/ingest'), {
      limit,
      closePool: false,
    })

    // 3) Rescore clusters
    const rescoreResult = await safeRun(import('@/scripts/rescore'), {
      closePool: false,
    })

    // 4) Rewrite recent headlines (using the currently configured model)
    const rewriteResult = await safeRun(import('@/scripts/rewrite'), {
      limit: 40,
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
      },
    })
  } catch (err: any) {
    // Try to cleanly close the pool even on error.
    await endPool().catch(() => {})
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    )
  }
}

// Support POST as well (handy for manual triggering)
export const POST = GET
