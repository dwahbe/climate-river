// app/api/ingest/route.ts
// Run on the Node.js runtime (not Edge) so we can use pg, fs, rss-parser, etc.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

// POST /api/ingest
// Header: authorization: Bearer <ADMIN_TOKEN>
export async function POST(req: Request) {
  const token = req.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/, '')
    .trim()

  if (!token || token !== process.env.ADMIN_TOKEN) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    )
  }

  try {
    // Dynamic import at request time to avoid bundling the script during build
    const mod = await import('../../../scripts/ingest') // from app/api/ingest/route.ts → ../../../scripts/ingest.ts
    if (typeof mod.run !== 'function') {
      throw new Error('scripts/ingest.ts must export a `run()` function')
    }
    await mod.run()
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}
