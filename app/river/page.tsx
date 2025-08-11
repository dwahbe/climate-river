// app/river/page.tsx
import Link from 'next/link'
import * as DB from '@/lib/db'

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
  // Main river rows
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

  // Latest ingest time (fallback to now if empty)
  const latest = await DB.query<{ ts: string }>(`
    select coalesce(max(fetched_at), now()) as ts
    from articles
  `)
  const lastTs = latest.rows[0]?.ts ?? new Date().toISOString()

  // Format in Mexico City time (matches your working timezone)
  const lastFormatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date(lastTs))

  return (
    <main style={{ padding: '24px 24px 56px', maxWidth: 880 }}>
      <section style={{ display: 'grid', gap: 14 }}>
        {rows.map((r) => (
          <article
            key={r.cluster_id}
            style={{ padding: '14px 0', borderBottom: '1px solid #f1f5f9' }}
          >
            <h3
              style={{
                fontSize: 16,
                fontWeight: 600,
                lineHeight: 1.35,
                marginBottom: 6,
              }}
            >
              <a
                href={r.lead_url}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: 'none', color: '#0f172a' }}
              >
                {r.lead_title}
              </a>
            </h3>
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                color: '#6b7280',
                fontSize: 12,
              }}
            >
              <span>{new Date(r.published_at).toLocaleString()}</span>
              <span>•</span>
              <span>{r.size} stories</span>
              <span>•</span>
              <span>{r.sources_count} sources</span>
              <span style={{ flex: 1 }} />
              <Link
                href={`/river/${r.cluster_id}`}
                style={{ color: '#334155' }}
              >
                Open cluster →
              </Link>
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
