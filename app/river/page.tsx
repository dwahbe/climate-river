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

function timeAgo(iso: string) {
  const t = new Date(iso).getTime()
  const mins = Math.max(1, Math.round((Date.now() - t) / 60000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h`
  const d = Math.round(hrs / 24)
  return `${d}d`
}
function host(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export default async function RiverPage() {
  const { rows } = await DB.query<Row>(`
    with lead as (
      select cs.cluster_id, cs.size, cs.score,
             a.title as lead_title, a.canonical_url as lead_url, a.published_at
      from cluster_scores cs
      join articles a on a.id = cs.lead_article_id
      order by cs.score desc
      limit 120
    ),
    srcs as (
      select ac.cluster_id, count(distinct s.id) as sources_count
      from article_clusters ac
      join articles a on a.id = ac.article_id
      join sources s on s.id = a.source_id
      group by ac.cluster_id
    )
    select l.*, coalesce(s.sources_count, 1) as sources_count
    from lead l left join srcs s on s.cluster_id = l.cluster_id
  `)

  return (
    <div className="container river">
      <p className="note">
        A quiet stream of climate stories. Sorted by momentum.
      </p>
      {rows.map((r) => (
        <article key={r.cluster_id} className="entry">
          <h3 className="title">
            <a href={r.lead_url} target="_blank" rel="noreferrer">
              {r.lead_title}
            </a>
          </h3>
          <div className="score">{Math.round(r.score)}</div>
          <div className="meta">
            <span>{host(r.lead_url)}</span>
            <span className="dot" />
            <span>{timeAgo(r.published_at)}</span>
            <span className="dot" />
            <span className="badge">{r.size} articles</span>
            <span className="badge">{r.sources_count} sources</span>
            <span style={{ flex: 1 }} />
            <Link href={`/river/${r.cluster_id}`}>Open cluster →</Link>
          </div>
        </article>
      ))}
    </div>
  )
}
