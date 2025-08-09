export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

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
    const mod = await import('../../../scripts/ingest') // runtime import
    if (typeof mod.run !== 'function')
      throw new Error('scripts/ingest.ts must export run()')
    await mod.run()
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    )
  }
}
