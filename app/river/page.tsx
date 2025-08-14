// app/river/page.tsx
import Link from 'next/link'
import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'

type SubLink = {
  article_id: number
  title: string
  url: string
  source: string | null
  author: string | null
  published_at: string
}

type Row = {
  cluster_id: number
  lead_article_id: number
  lead_title: string
  lead_url: string
  lead_dek: string | null
  lead_source: string | null // coalesced: articles.publisher_name -> sources.name
  lead_homepage: string | null // coalesced: articles.publisher_homepage -> sources.homepage_url
  lead_author: string | null
  published_at: string
  size: number
  score: number
  sources_count: number
  subs: SubLink[] // always an array thanks to SQL coalesce('[]'::json)
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
    WITH lead AS (
      SELECT
        cs.cluster_id,
        cs.size,
        cs.score,
        a.id AS lead_article_id,
        COALESCE(a.rewritten_title, a.title) AS lead_title,
        a.canonical_url  AS lead_url,
        a.dek            AS lead_dek,
        a.author         AS lead_author,
        a.published_at,
        -- Prefer per-article publisher (e.g., Google News true outlet), else source default
        COALESCE(a.publisher_name, s.name)              AS lead_source,
        COALESCE(a.publisher_homepage, s.homepage_url)  AS lead_homepage
      FROM cluster_scores cs
      JOIN articles a ON a.id = cs.lead_article_id
      LEFT JOIN sources s ON s.id = a.source_id
      ORDER BY cs.score DESC
      LIMIT 20
    ),
    srcs AS (
      SELECT ac.cluster_id, COUNT(DISTINCT s.id) AS sources_count
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      JOIN sources s ON s.id = a.source_id
      GROUP BY ac.cluster_id
    )
    SELECT
      l.cluster_id,
      l.lead_article_id,
      l.lead_title,
      l.lead_url,
      l.lead_dek,
      l.lead_author,
      l.lead_source,
      l.lead_homepage,
      l.published_at,
      l.size,
      l.score,
      COALESCE(s.sources_count, 1) AS sources_count,

      (
        SELECT COUNT(*)
        FROM article_clusters ac
        JOIN articles a2 ON a2.id = ac.article_id
        WHERE ac.cluster_id = l.cluster_id
          AND a2.id <> l.lead_article_id
      )::int AS subs_total,

      (
        SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.published_at DESC), '[]'::json)
        FROM (
          SELECT
            a2.id            AS article_id,
            a2.title         AS title,
            a2.canonical_url AS url,
            -- Left join so we don't drop rows if a source record is missing
            COALESCE(a2.publisher_name, s2.name) AS source,
            a2.author       AS author,
            a2.published_at
          FROM article_clusters ac2
          JOIN articles a2 ON a2.id = ac2.article_id
          LEFT JOIN sources s2 ON s2.id = a2.source_id
          WHERE ac2.cluster_id = l.cluster_id
            AND a2.id <> l.lead_article_id
          ORDER BY a2.published_at DESC
          LIMIT 8
        ) x
      ) AS subs
    FROM lead l
    LEFT JOIN srcs s ON s.cluster_id = l.cluster_id
    ORDER BY l.score DESC
  `)

  return (
    <section className="grid gap-3 sm:gap-3.5">
      {rows.map((r) => {
        const secondaries = r.subs ?? []
        const shown = secondaries.length
        const moreCount = Math.max(0, r.subs_total - shown)
        const isCluster = r.size > 1

        const publisher = r.lead_source || hostFrom(r.lead_url)
        const leadClickHref = `/api/click?aid=${r.lead_article_id}&url=${encodeURIComponent(
          r.lead_url
        )}`

        return (
          <article key={r.cluster_id} className="py-3 border-b border-zinc-300">
            {/* Author / Publisher */}
            {(r.lead_author || publisher) && (
              <div className="text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500 mb-1">
                {r.lead_author ? (
                  <>
                    <span className="text-zinc-700">{r.lead_author}</span>
                    <span className="px-1 text-zinc-400">/</span>
                  </>
                ) : null}
                {r.lead_homepage ? (
                  <a
                    href={r.lead_homepage}
                    target="_blank"
                    rel="noopener noreferrer"
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
                href={leadClickHref}
                target="_blank"
                rel="noopener noreferrer"
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

            {/* Meta & open cluster link */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] sm:text-xs text-zinc-500">
              <LocalTime iso={r.published_at} />

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
                  <span className="ml-auto" />
                  <Link
                    href={`/river/${r.cluster_id}`}
                    className="text-zinc-600 hover:text-zinc-800"
                    prefetch={false}
                  >
                    Open cluster →
                  </Link>
                </>
              )}
            </div>

            {/* Nested "More:" like Techmeme */}
            {isCluster && secondaries.length > 0 && (
              <div className="mt-1.5 text-[13px] leading-6 text-zinc-700">
                <span className="font-semibold text-zinc-900">More:</span>{' '}
                {secondaries.map((s, i) => {
                  const href = `/api/click?aid=${s.article_id}&url=${encodeURIComponent(
                    s.url
                  )}`
                  return (
                    <span key={s.article_id}>
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-900 hover:underline decoration-zinc-300"
                        title={s.title}
                      >
                        {s.source ?? hostFrom(s.url)}
                      </a>
                      {i < secondaries.length - 1 ? ', ' : ''}
                    </span>
                  )
                })}
                {moreCount > 0 && (
                  <>
                    {shown > 0 ? ', ' : null}
                    <Link
                      href={`/river/${r.cluster_id}`}
                      className="text-zinc-700 hover:text-zinc-900"
                      prefetch={false}
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
