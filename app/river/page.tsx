import * as DB from '@/lib/db'
import Link from 'next/link'

type Row = {
  cluster_id: number
  lead_title: string
  lead_url: string
  published_at: string
  size: number
  score: number
  sources_count: number
}

export const dynamic = 'force-dynamic'

export default async function RiverPage() {
  const { rows } = await DB.query<Row>(`
    with lead as (
      select
        cs.cluster_id,
        cs.size,
        cs.score,
        a.title         as lead_title,
        a.canonical_url as lead_url,
        a.published_at
      from cluster_scores cs
      join articles a on a.id = cs.lead_article_id
      order by cs.score desc
      limit 80
    ),
    srcs as (
      select ac.cluster_id, count(distinct s.id) as sources_count
      from article_clusters ac
      join articles a on a.id = ac.article_id
      join sources s on s.id = a.source_id
      group by ac.cluster_id
    )
    select l.*, coalesce(s.sources_count, 1) as sources_count
    from lead l
    left join srcs s on s.cluster_id = l.cluster_id
  `)

  return (
    <main>
      <div className="toolbar">
        <input className="input" placeholder="Search (coming soon)" disabled />
        <span className="pill">Auto-updating</span>
        <span className="pill">Neutral ranking</span>
      </div>

      <section className="grid">
        {rows.map((r) => (
          <article key={r.cluster_id} className="card">
            <h3 className="title">
              <a href={r.lead_url} target="_blank" rel="noreferrer">
                {r.lead_title}
              </a>
            </h3>
            <div className="meta">
              <span>{new Date(r.published_at).toLocaleString()}</span>
              <span>•</span>
              <span>{r.size} stories</span>
              <span>•</span>
              <span>{r.sources_count} sources</span>
              <span style={{ flex: 1 }} />
              <Link href={`/river/${r.cluster_id}`}>Open cluster →</Link>
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
