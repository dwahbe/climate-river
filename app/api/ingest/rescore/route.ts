export const runtime = 'nodejs'
import { NextResponse } from 'next/server'
import * as DB from '@/lib/db'

export async function GET() {
  // simple rescore: recompute score = freshness + size
  await DB.query(`
    insert into cluster_scores (cluster_id, lead_article_id, size, sources_count, score, computed_at, score_notes)
    select c.id,
           (select id from articles a join article_clusters ac on ac.article_id=a.id where ac.cluster_id=c.id order by a.published_at desc limit 1) as lead,
           count(ac.article_id) as size,
           count(distinct s.id) as sources_count,
           (count(ac.article_id) * 0.6 + extract(epoch from (now() - min(a.published_at)))/-7200 * 0.4) as score,
           now(),
           'freshness + size'
    from clusters c
    join article_clusters ac on ac.cluster_id=c.id
    join articles a on a.id=ac.article_id
    join sources s on s.id=a.source_id
    group by c.id
    on conflict (cluster_id) do update
      set score=excluded.score, size=excluded.size, sources_count=excluded.sources_count, lead_article_id=excluded.lead_article_id, computed_at=excluded.computed_at, score_notes=excluded.score_notes
  `)
  return NextResponse.json({ ok: true })
}
