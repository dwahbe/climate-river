// app/river/page.tsx
import Link from 'next/link'
import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'
import RiverControls from '@/components/RiverControls'
import { unstable_noStore as noStore } from 'next/cache'

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
  lead_source: string | null
  lead_homepage: string | null
  lead_author: string | null
  published_at: string
  size: number
  score: number
  sources_count: number
  subs: SubLink[]
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

export default async function RiverPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>
}) {
  noStore()

  const isLatest =
    (Array.isArray(searchParams?.view)
      ? searchParams?.view[0]
      : searchParams?.view) === 'latest'
  const topWindowHours = 72
  const limit = 28

  const { rows } = await DB.query<Row>(
    `
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
        COALESCE(a.publisher_name, s.name)              AS lead_source,
        COALESCE(a.publisher_homepage, s.homepage_url)  AS lead_homepage
      FROM cluster_scores cs
      JOIN articles a ON a.id = cs.lead_article_id
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE $1::boolean
            OR a.published_at >= now() - make_interval(hours => $2::int)
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

      (SELECT COUNT(DISTINCT s.id)
         FROM article_clusters ac
         JOIN articles a2 ON a2.id = ac.article_id
         LEFT JOIN sources s ON s.id = a2.source_id
        WHERE ac.cluster_id = l.cluster_id)::int AS sources_count,

      (SELECT COUNT(*)
         FROM article_clusters ac
         JOIN articles a2 ON a2.id = ac.article_id
        WHERE ac.cluster_id = l.cluster_id
          AND a2.id <> l.lead_article_id)::int AS subs_total,

      (SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.published_at DESC), '[]'::json)
         FROM (
           SELECT a2.id AS article_id, a2.title, a2.canonical_url AS url,
                  COALESCE(a2.publisher_name, s2.name) AS source,
                  a2.author, a2.published_at
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
    ORDER BY
      CASE WHEN $1::boolean THEN l.published_at END DESC NULLS LAST, -- Latest
      CASE WHEN NOT $1::boolean THEN l.score END DESC NULLS LAST,     -- Top
      CASE WHEN NOT $1::boolean THEN (l.cluster_id % 13) END DESC,    -- stable jitter for Top ties
      l.cluster_id DESC
    LIMIT $3::int
  `,
    [isLatest, topWindowHours, limit]
  )

  return (
    <>
      {/* Full-width, minimal sticky header with no box */}
      <header className="sticky top-0 z-10 bg-transparent">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-2 sm:py-2.5">
          <RiverControls />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
        <section className="mt-1 sm:mt-2">
          {rows.map((r) => {
            const secondaries = r.subs ?? []
            const moreCount = Math.max(0, r.subs_total - secondaries.length)
            const isCluster = r.size > 1
            const publisher = r.lead_source || hostFrom(r.lead_url)
            const leadClickHref = `/api/click?aid=${r.lead_article_id}&url=${encodeURIComponent(
              r.lead_url
            )}`

            return (
              <article
                key={r.cluster_id}
                className="group relative py-5 sm:py-6 border-b border-zinc-200"
              >
                {(r.lead_author || publisher) && (
                  <div className="text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500 mb-1.5">
                    {r.lead_author && (
                      <span className="text-zinc-700">{r.lead_author}</span>
                    )}
                    {r.lead_author && (
                      <span className="px-1 text-zinc-400">—</span>
                    )}
                    {r.lead_homepage ? (
                      <a
                        href={r.lead_homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-zinc-700 no-underline"
                      >
                        {publisher}
                      </a>
                    ) : (
                      publisher
                    )}
                  </div>
                )}

                {/* Headline — no underline; underline only on hover/focus */}
                <h3 className="text-[18px] sm:text-[19px] md:text-[20px] font-semibold leading-snug tracking-tight">
                  <a
                    href={leadClickHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline hover:underline decoration-zinc-300 underline-offset-2 decoration-2 text-zinc-950 hover:text-zinc-900 focus:outline-none focus-visible:underline rounded transition-colors"
                  >
                    {r.lead_title}
                  </a>
                </h3>

                {r.lead_dek && (
                  <p className="mt-1 text-sm sm:text-[0.95rem] text-zinc-600">
                    {r.lead_dek}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] sm:text-xs text-zinc-500">
                  <LocalTime iso={r.published_at} />
                  {isCluster && (
                    <>
                      <span>·</span>
                      <span>
                        {r.size} {r.size === 1 ? 'story' : 'stories'}
                      </span>
                      <span>·</span>
                      <span>
                        {r.sources_count}{' '}
                        {r.sources_count === 1 ? 'source' : 'sources'}
                      </span>
                      <span className="ml-auto" />
                      <Link
                        href={`/river/${r.cluster_id}`}
                        className="opacity-70 group-hover:opacity-100 text-zinc-600 hover:text-zinc-800 transition no-underline"
                        prefetch={false}
                      >
                        Open →
                      </Link>
                    </>
                  )}
                </div>

                {isCluster && secondaries.length > 0 && (
                  <div className="mt-1.5 text-[13px] leading-6 text-zinc-700">
                    <span className="sr-only">More sources:</span>
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
                            className="no-underline hover:underline decoration-zinc-300 underline-offset-2 text-zinc-800"
                            title={s.title}
                          >
                            {s.source ?? hostFrom(s.url)}
                          </a>
                          {i < secondaries.length - 1 && (
                            <span className="text-zinc-400">, </span>
                          )}
                        </span>
                      )
                    })}
                    {moreCount > 0 && (
                      <>
                        {secondaries.length > 0 && (
                          <span className="text-zinc-400">, </span>
                        )}
                        <Link
                          href={`/river/${r.cluster_id}`}
                          className="no-underline hover:underline text-zinc-700 hover:text-zinc-900"
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
      </div>
    </>
  )
}
