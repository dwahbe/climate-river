export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import * as DB from '@/lib/db'

export async function GET() {
  // Recompute a simple score = size + freshness factor
  await DB.query(`
    insert into cluster_scores (
      cluster_id,
      lead_article_id,
      size,
      score,
      computed_at,
      score_notes
    )
    select
      c.id as cluster_id,
      (
        select a2.id
        from articles a2
        join article_clusters ac2 on ac2.article_id = a2.id
        where ac2.cluster_id = c.id
        order by a2.published_at desc
        limit 1
      ) as lead_article_id,
      count(ac.article_id) as size,
      (
        -- size weight + freshness (newer is better)
        (count(ac.article_id)) * 0.6
        + (extract(epoch from (now() - max(a.published_at))) / -3600.0) * 0.4
      ) as score,
      now() as computed_at,
      'freshness + size' as score_notes
    from clusters c
    join article_clusters ac on ac.cluster_id = c.id
    join articles a on a.id = ac.article_id
    group by c.id
    on conflict (cluster_id) do update
      set size = excluded.size,
          score = excluded.score,
          lead_article_id = excluded.lead_article_id,
          computed_at = excluded.computed_at,
          score_notes = excluded.score_notes
  `)

  return NextResponse.json({ ok: true })
}
