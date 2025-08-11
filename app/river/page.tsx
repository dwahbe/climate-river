// app/river/page.tsx
import Link from 'next/link'
import * as DB from '@/lib/db'

type SubLink = { title: string; url: string; source: string }
type Row = {
  cluster_id: number
  lead_title: string
  lead_url: string
  lead_dek: string | null
  lead_source: string | null
  lead_homepage: string | null
  published_at: string
  size: number
  score: number
  sources_count: number
  subs: SubLink[] | null
  subs_total: number
}

export const dynamic = 'force-dynamic'

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export default async function RiverPage() {
  const { rows } = await DB.query<Row>(`
    with lead as (
      select
        cs.cluster_id,
        cs.size,
        cs.score,
        a.id             as lead_article_id,
        a.title          as lead_title,
        a.canonical_url  as lead_url,
        a.dek            as lead_dek,
        a.published_at,
        s.name           as lead_source,
        s.homepage_url   as lead_homepage
      from cluster_scores cs
      join articles a on a.id = cs.lead_article_id
      left join sources s on s.id = a.source_id
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
    select
      l.cluster_id,
      l.lead_title,
      l.lead_url,
      l.lead_dek,
      l.lead_source,
      l.lead_homepage,
      l.published_at,
      l.size,
      l.score,
      coalesce(s.sources_count, 1) as sources_count,

      (
        select count(*)
        from article_clusters ac
        join articles a2 on a2.id = ac.article_id
        where ac.cluster_id = l.cluster_id
          and a2.id <> l.lead_article_id
      )::int as subs_total,

      (
        select coalesce(json_agg(row_to_json(x) order by x.published_at desc), '[]'::json)
        from (
          select a2.title as title,
                 a2.canonical_url as url,
                 s2.name as source,
                 a2.published_at
          from article_clusters ac2
          join articles a2 on a2.id = ac2.article_id
          join sources s2  on s2.id = a2.source_id
          where ac2.cluster_id = l.cluster_id
            and a2.id <> l.lead_article_id
          order by a2.published_at desc
          limit 6
        ) x
      ) as subs
    from lead l
    left join srcs s on s.cluster_id = l.cluster_id
  `)

  const latest = await DB.query<{ ts: string }>(`
    select coalesce(max(fetched_at), now()) as ts
    from articles
  `)
  const lastTs = latest.rows[0]?.ts ?? new Date().toISOString()
  const lastFormatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date(lastTs))

  return (
    <main
      style={{
        padding: '20px 24px 56px',
        maxWidth: 880,
      }}
    >
      <section style={{ display: 'grid', gap: 6 }}>
        {rows.map((r) => {
          const secondaries = (r.subs ?? []) as SubLink[]
          const shown = secondaries.length
          const moreCount = Math.max(0, r.subs_total - shown)
          const isCluster = r.size > 1

          const publisher = r.lead_source || hostFrom(r.lead_url)
          const Bullet = () => (
            <span aria-hidden style={{ opacity: 0.6 }}>
              •
            </span>
          )

          return (
            <article
              key={r.cluster_id}
              style={{
                padding: '18px 0',
                borderBottom: '1px solid #e5e7eb',
              }}
            >
              {/* Publisher (tiny) */}
              {publisher && (
                <div
                  style={{
                    fontSize: 12,
                    color: '#475569',
                    fontWeight: 600,
                    letterSpacing: '.02em',
                    marginBottom: 2,
                  }}
                >
                  {r.lead_homepage ? (
                    <a
                      href={r.lead_homepage}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: 'inherit',
                        textDecoration: 'none',
                      }}
                    >
                      {publisher}
                    </a>
                  ) : (
                    publisher
                  )}
                </div>
              )}

              {/* Headline + dek */}
              <h3
                style={{
                  fontSize: 19,
                  fontWeight: 700,
                  lineHeight: 1.35,
                  margin: 0,
                  letterSpacing: '-0.01em',
                }}
              >
                <a
                  href={r.lead_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    textDecoration: 'none',
                    color: '#0f172a',
                  }}
                >
                  {r.lead_title}
                </a>
              </h3>

              {r.lead_dek && (
                <p
                  style={{
                    margin: '6px 0 0',
                    color: '#475569',
                    fontSize: 14,
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical' as any,
                    overflow: 'hidden',
                  }}
                >
                  {r.lead_dek}
                </p>
              )}

              {/* Meta line */}
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  color: '#6b7280',
                  fontSize: 12,
                  marginTop: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span>{new Date(r.published_at).toLocaleString()}</span>

                {isCluster && (
                  <>
                    <Bullet />
                    <span>
                      {r.size} {r.size === 1 ? 'story' : 'stories'}
                    </span>
                    <Bullet />
                    <span>
                      {r.sources_count}{' '}
                      {r.sources_count === 1 ? 'source' : 'sources'}
                    </span>
                    <span style={{ flex: 1 }} />
                    <Link
                      href={`/river/${r.cluster_id}`}
                      style={{
                        color: '#334155',
                        textDecoration: 'none',
                      }}
                    >
                      Open cluster →
                    </Link>
                  </>
                )}
              </div>

              {/* Compact “More:” list only for multi-story clusters */}
              {isCluster && secondaries.length > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    color: '#334155',
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  <span style={{ fontWeight: 600, color: '#0f172a' }}>
                    More:
                  </span>{' '}
                  {secondaries.map((s, i) => (
                    <span key={s.url}>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: '#0f172a',
                          textDecoration: 'none',
                        }}
                      >
                        {s.source}
                      </a>
                      {i < secondaries.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                  {moreCount > 0 && (
                    <>
                      {shown > 0 ? ', ' : null}
                      <Link
                        href={`/river/${r.cluster_id}`}
                        style={{ color: '#334155', textDecoration: 'none' }}
                      >
                        and {moreCount} more
                      </Link>
                    </>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </section>

      <div
        style={{
          textAlign: 'center',
          color: '#6b7280',
          fontSize: 12,
          marginTop: 24,
        }}
      >
        Last updated {lastFormatted}
      </div>
    </main>
  )
}
