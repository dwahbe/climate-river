import * as DB from '@/lib/db'
import Link from 'next/link'

type A = {
  id: number
  title: string
  canonical_url: string
  published_at: string
  source_name: string
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

export default async function Cluster({ params }: { params: { id: string } }) {
  const id = Number(params.id)
  const { rows } = await DB.query<A>(
    `
    select a.id, a.title, a.canonical_url, a.published_at, s.name as source_name
    from article_clusters ac
    join articles a on a.id = ac.article_id
    join sources s on s.id = a.source_id
    where ac.cluster_id = $1
    order by a.published_at desc
  `,
    [id]
  )

  return (
    <div className="container cluster">
      <div className="head">
        <h2 style={{ margin: '0 0 6px' }}>Cluster #{id}</h2>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          {rows.length} articles
        </p>
        <p style={{ margin: '10px 0 0' }}>
          <Link href="/river">← Back to river</Link>
        </p>
      </div>
      <div className="list">
        {rows.map((a) => (
          <article key={a.id} className="item">
            <div className="a-title">
              <a href={a.canonical_url} target="_blank" rel="noreferrer">
                {a.title}
              </a>
            </div>
            <div className="a-meta">
              {a.source_name} • {timeAgo(a.published_at)}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
