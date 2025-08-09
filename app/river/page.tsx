export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import * as DB from '@/lib/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'

type Item = { title: string; url: string; source: string; published_at: string }

export default async function ClusterPage({
  params,
}: {
  params: { id: string }
}) {
  const idRaw = params?.id ?? ''
  if (!/^\d+$/.test(idRaw)) notFound()
  const id = Number(idRaw)

  let rows: Item[] = []
  let error: string | null = null

  try {
    const res = await DB.query<Item>(
      `
      select
        a.title,
        a.canonical_url as url,
        s.name as source,
        a.published_at
      from article_clusters ac
      join articles a on a.id = ac.article_id
      join sources  s on s.id = a.source_id
      where ac.cluster_id = $1
      order by a.published_at desc
    `,
      [id]
    )
    rows = res.rows
  } catch (e: any) {
    error = e?.message || String(e)
    console.error('ClusterPage query error:', e)
  }

  const lead = rows[0]

  return (
    <main>
      <div className="toolbar">
        <Link href="/river" className="btn">
          ← Back to River
        </Link>
        <span className="pill">{rows.length} links</span>
      </div>

      {error ? (
        <div className="card" style={{ padding: 16 }}>
          <h3 className="title">Couldn’t load this cluster</h3>
          <div className="meta">Error: {error}</div>
        </div>
      ) : (
        <>
          <h1 style={{ margin: '8px 0 16px', fontSize: 22 }}>
            {lead ? lead.title : 'Cluster'}
          </h1>

          {rows.length === 0 ? (
            <p className="pill">No articles for this cluster.</p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'grid',
                gap: 10,
              }}
            >
              {rows.map((it, i) => (
                <li key={i} className="card" style={{ padding: 14 }}>
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noreferrer"
                    className="title"
                    style={{ display: 'inline-block', marginBottom: 6 }}
                  >
                    {it.title}
                  </a>
                  <div className="meta">
                    <span>{it.source}</span>
                    <span>•</span>
                    <span>{new Date(it.published_at).toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
