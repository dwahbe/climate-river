import Link from 'next/link'
import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'
import RiverControls from '@/components/RiverControls'
import PublisherLink from '@/components/PublisherLink'
import SourceTooltip from '@/components/SourceTooltip'
import { CATEGORIES } from '@/lib/tagger'
import { unstable_noStore as noStore } from 'next/cache'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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
  all_articles_by_source: Record<
    string,
    Array<{
      article_id: number
      title: string
      url: string
      author: string | null
    }>
  >
}

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export default async function RiverPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const searchParams = await props.searchParams
  noStore()

  const view = Array.isArray(searchParams?.view)
    ? searchParams?.view[0]
    : searchParams?.view

  const isLatest = view === 'latest'

  // Check if it's a category view
  const selectedCategory = CATEGORIES.find((c) => c.slug === view)?.slug
  const isCategory = !!selectedCategory

  const topWindowHours = 168 // Expanded to 1 week to ensure enough articles
  const topLimit = 10 // Top tab: 10 articles
  const latestLimit = 20 // Latest tab: 20 articles
  const categoryLimit = 15 // Category tabs: 15 articles

  const limit = isCategory ? categoryLimit : isLatest ? latestLimit : topLimit

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
      -- Category filtering join
      ${
        isCategory
          ? `
      JOIN article_categories ac ON ac.article_id = a.id
      JOIN categories cat ON cat.id = ac.category_id AND cat.slug = $4
      `
          : ''
      }
      WHERE ($1::boolean
         OR a.published_at >= now() - make_interval(hours => $2::int))
        AND a.canonical_url NOT LIKE 'https://news.google.com%'
        AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
        AND a.canonical_url NOT LIKE 'https://www.msn.com%'
        ${isCategory ? 'AND ac.confidence >= 0.3' : ''}
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

      (
        WITH x AS (
          SELECT
            a2.id            AS article_id,
            a2.title,
            a2.canonical_url AS url,
            COALESCE(a2.publisher_name, s2.name) AS source,
            a2.author,
            a2.published_at,

            -- 👇 Hardened host normalization:
            -- 1) extract hostname
            -- 2) lowercase
            -- 3) strip common dupy subdomains (www., m., mobile., amp., amp-cdn., edition., news., beta.)
            COALESCE(
              a2.publisher_host,
              regexp_replace(
                lower(
                  regexp_replace(
                    COALESCE(a2.publisher_homepage, a2.canonical_url),
                    '^https?://([^/]+).*$',
                    '\\1'
                  )
                ),
                '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\.',
                ''
              )
            ) AS host_norm,

            lower(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    COALESCE(a2.rewritten_title, a2.title),
                    '\\s[-—]\\s[^-—]+$',
                    '',
                    'g'
                  ),
                  '[[:punct:]]',
                  ' ',
                  'g'
                ),
                '\\s+',
                ' ',
                'g'
              )
            ) AS title_norm
          FROM article_clusters ac2
          JOIN articles a2 ON a2.id = ac2.article_id
          LEFT JOIN sources s2 ON s2.id = a2.source_id
          WHERE ac2.cluster_id = l.cluster_id
            AND a2.id <> l.lead_article_id
        )
        SELECT COALESCE(json_agg(row_to_json(y)), '[]'::json)
        FROM (
          -- keep one per outlet (host_norm), exclude aggregators and lead article's domain
          SELECT DISTINCT ON (host_norm)
            article_id, title, url, source, author, published_at
          FROM x
          WHERE url NOT LIKE 'https://news.google.com%'
            AND url NOT LIKE 'https://news.yahoo.com%'
            AND url NOT LIKE 'https://www.msn.com%'
            AND host_norm NOT IN ('news.google.com', 'news.yahoo.com', 'msn.com')
            AND (
              l.size > 1 OR -- Allow same outlet for semantic clusters (size > 1)
              host_norm <> (
                SELECT COALESCE(
                  lead_a.publisher_host,
                  regexp_replace(
                    lower(
                      regexp_replace(
                        COALESCE(lead_a.publisher_homepage, lead_a.canonical_url),
                        '^https?://([^/]+).*$',
                        '\\1'
                      )
                    ),
                    '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\.',
                    ''
                  )
                )
                FROM articles lead_a 
                WHERE lead_a.id = l.lead_article_id
              )
            )
          ORDER BY
            host_norm,
            published_at DESC
          LIMIT 8
        ) y
      ) AS subs,

      (
        SELECT json_object_agg(
          source_name,
          articles
        )
        FROM (
          SELECT 
            COALESCE(a3.publisher_name, s3.name) as source_name,
            json_agg(
              json_build_object(
                'article_id', a3.id,
                'title', COALESCE(a3.rewritten_title, a3.title),
                'url', a3.canonical_url,
                'author', a3.author
              ) ORDER BY a3.published_at DESC
            ) as articles
          FROM article_clusters ac3
          JOIN articles a3 ON a3.id = ac3.article_id
          LEFT JOIN sources s3 ON s3.id = a3.source_id
          WHERE ac3.cluster_id = l.cluster_id
            AND a3.canonical_url NOT LIKE 'https://news.google.com%'
            AND a3.canonical_url NOT LIKE 'https://news.yahoo.com%'
            AND a3.canonical_url NOT LIKE 'https://www.msn.com%'
          GROUP BY COALESCE(a3.publisher_name, s3.name)
          HAVING COUNT(*) > 0
        ) source_groups
      ) AS all_articles_by_source
    FROM lead l
    ORDER BY
      CASE WHEN $1::boolean THEN l.published_at END DESC NULLS LAST, -- Latest
      CASE WHEN NOT $1::boolean THEN l.score END DESC NULLS LAST, -- Top & Category (by score)
      CASE WHEN NOT $1::boolean THEN (l.cluster_id % 13) END DESC, -- stable jitter
      l.cluster_id DESC
    LIMIT $3::int
  `,
    isCategory
      ? [isLatest, topWindowHours, limit, selectedCategory]
      : [isLatest, topWindowHours, limit]
  )

  return (
    <>
      <header className="z-10 bg-transparent">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-2 sm:py-2.5">
          <RiverControls
            currentView={view}
            selectedCategory={selectedCategory}
          />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
        <section>
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
                className="group relative py-5 sm:py-6 border-b border-zinc-200/70"
              >
                {(r.lead_author || publisher) && (
                  <div className="mb-1.5 text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500">
                    {r.lead_author && (
                      <span className="text-zinc-700">{r.lead_author}</span>
                    )}
                    {r.lead_author && publisher && (
                      <span className="px-1 text-zinc-400">•</span>
                    )}
                    <SourceTooltip
                      sourceName={publisher}
                      articles={r.all_articles_by_source?.[publisher] || []}
                    >
                      {r.lead_homepage ? (
                        <PublisherLink
                          href={r.lead_homepage}
                          className="hover:underline"
                        >
                          {publisher}
                        </PublisherLink>
                      ) : (
                        <span>{publisher}</span>
                      )}
                    </SourceTooltip>
                  </div>
                )}

                <h3 className="text-[18px] sm:text-[19px] md:text-[20px] font-semibold leading-snug tracking-tight text-pretty">
                  <a
                    href={leadClickHref}
                    className="no-underline hover:underline text-zinc-950 hover:text-zinc-900 focus-visible:underline rounded transition"
                  >
                    {r.lead_title}
                  </a>
                </h3>

                {r.lead_dek && (
                  <p className="mt-1 text-sm sm:text-[0.95rem] text-zinc-600 text-pretty">
                    {r.lead_dek}
                  </p>
                )}

                {/* Timestamp */}
                <div className="mt-2 text-xs text-zinc-500">
                  <LocalTime iso={r.published_at} />
                </div>

                {/* Read more sources */}
                {isCluster && secondaries.length > 0 && (
                  <div className="mt-2 text-sm text-zinc-700">
                    <Link
                      href={`/river/${r.cluster_id}`}
                      className="no-underline hover:underline text-zinc-600 hover:text-zinc-800 transition-colors font-medium"
                      prefetch={false}
                    >
                      Related articles:
                    </Link>
                    <span> </span>
                    {secondaries.map((s, i) => {
                      const href = `/api/click?aid=${s.article_id}&url=${encodeURIComponent(
                        s.url
                      )}`
                      const sourceName = s.source ?? hostFrom(s.url)
                      return (
                        <span key={s.article_id}>
                          <SourceTooltip
                            sourceName={sourceName}
                            articles={
                              r.all_articles_by_source?.[sourceName] || []
                            }
                          >
                            <a
                              href={href}
                              className="no-underline hover:underline text-zinc-700 hover:text-zinc-900 transition-colors"
                            >
                              {sourceName}
                            </a>
                          </SourceTooltip>
                          {i < secondaries.length - 1 && (
                            <span className="text-zinc-400">, </span>
                          )}
                        </span>
                      )
                    })}
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
