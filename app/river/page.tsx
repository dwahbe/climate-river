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
      limit 20
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

  return (
    <section className="grid gap-3 sm:gap-3.5">
      {rows.map((r) => {
        const secondaries = (r.subs ?? []) as SubLink[]
        const shown = secondaries.length
        const moreCount = Math.max(0, r.subs_total - shown)
        const isCluster = r.size > 1

        const publisher = r.lead_source || hostFrom(r.lead_url)

        return (
          <article key={r.cluster_id} className="py-3 border-b border-zinc-300">
            {/* Publisher */}
            {publisher && (
              <div className="text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500 mb-1">
                {r.lead_homepage ? (
                  <a
                    href={r.lead_homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="source-link text-zinc-500 hover:text-zinc-700"
                  >
                    {publisher}
                  </a>
                ) : (
                  publisher
                )}
              </div>
            )}
            {/* Headline */}
            <h3 className="text-[18px] sm:text-[19px] md:text-[20px] font-semibold leading-snug tracking-tight">
              <a
                href={r.lead_url}
                target="_blank"
                rel="noreferrer"
                className="headline-link text-zinc-950 hover:text-zinc-900 transition-colors"
              >
                {r.lead_title}
              </a>
            </h3>
            {/* Dek */}
            {r.lead_dek && (
              <p className="mt-1 text-sm sm:text-[0.95rem] text-zinc-600">
                {r.lead_dek}
              </p>
            )}

            {/* Meta */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] sm:text-xs text-zinc-500">
              <span>{new Date(r.published_at).toLocaleString()}</span>

              {isCluster && (
                <>
                  <span>•</span>
                  <span>
                    {r.size} {r.size === 1 ? 'story' : 'stories'}
                  </span>
                  <span>•</span>
                  <span>
                    {r.sources_count}{' '}
                    {r.sources_count === 1 ? 'source' : 'sources'}
                  </span>
                  <span className="ms-auto" />
                  <Link
                    href={`/river/${r.cluster_id}`}
                    className="text-zinc-600 hover:text-zinc-800"
                  >
                    Open cluster →
                  </Link>
                </>
              )}
            </div>

            {/* More (cluster only) */}
            {isCluster && secondaries.length > 0 && (
              <div className="mt-1.5 text-[13px] leading-6 text-zinc-700">
                <span className="font-semibold text-zinc-900">More:</span>{' '}
                {secondaries.map((s, i) => (
                  <span key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-900 hover:underline decoration-zinc-300"
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
                      className="text-zinc-700 hover:text-zinc-900"
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
  )
}
