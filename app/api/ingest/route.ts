// app/api/ingest/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { run } from '@/scripts/ingest'

function authorized(req: Request) {
  const h = headers()
  const isCron = h.get('x-vercel-cron') === '1'

  const url = new URL(req.url)
  const qToken = url.searchParams.get('token')?.trim()

  const auth = h.get('authorization') || ''
  const bearer = auth.replace(/^Bearer\s+/i, '').trim()

  const expected = (process.env.ADMIN_TOKEN || '').trim()
  return isCron || (!!expected && (qToken === expected || bearer === expected))
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  const t0 = Date.now()
  try {
    // IMPORTANT: run() should NOT call endPool() on API requests
    const result = await run()
    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}

export { GET as POST }
