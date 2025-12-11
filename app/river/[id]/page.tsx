import Link from 'next/link'
import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'
import ArticleStructuredData from '@/components/ArticleStructuredData'
import type { Metadata } from 'next'

// Cache for 5 minutes (300 seconds)
export const revalidate = 300
export const runtime = 'nodejs'

export async function generateMetadata(props: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const params = await props.params
  const cid = Number(params.id)

  const { rows } = await DB.query<{
    lead_title: string
    lead_dek: string | null
    lead_source: string | null
    size: number
  }>(
    `
    SELECT
      COALESCE(a.rewritten_title, a.title) AS lead_title,
      a.dek AS lead_dek,
      COALESCE(a.publisher_name, s.name) AS lead_source,
      cs.size
    FROM cluster_scores cs
    JOIN articles a ON a.id = cs.lead_article_id
    LEFT JOIN sources s ON s.id = a.source_id
    WHERE cs.cluster_id = $1::bigint
    LIMIT 1
    `,
    [cid]
  )

  const cluster = rows[0]
  if (!cluster) {
    return {
      title: 'Story Not Found',
      description: 'This climate news story could not be found.',
      robots: {
        index: false,
        follow: false,
      },
    }
  }

  const title = cluster.lead_title

  // Create SEO-optimized description that emphasizes aggregation and sources
  const description =
    cluster.size > 1
      ? `Coverage of "${cluster.lead_title}" from ${cluster.size} trusted climate news sources. Compare reporting from ${cluster.lead_source || 'leading outlets'} and more on Climate River.`
      : `Latest reporting on "${cluster.lead_title}" from ${cluster.lead_source || 'trusted climate news sources'}. Part of Climate River's curated climate news coverage.`

  // SEO Strategy: NOINDEX all story pages
  // Climate River should rank for aggregation/discovery terms, not individual stories
  // When users search for specific stories, the original outlets should appear
  // We want to be found via: "climate news", "climate news aggregator", etc.
  return {
    title,
    description,
    openGraph: {
      title: `${title} - Climate River`,
      description,
      url: `https://climateriver.org/river/${cid}`,
      type: 'article',
    },
    twitter: {
      title: `${title} - Climate River`,
      description,
      card: 'summary_large_image',
    },
    alternates: {
      canonical: `https://climateriver.org/river/${cid}`,
    },
    robots: {
      index: false, // Don't compete with source outlets for story searches
      follow: true, // Still follow links for crawling and link equity
      googleBot: {
        index: false,
        follow: true,
      },
    },
  }
}

type Sub = {
  article_id: number
  title: string
  url: string
  source: string | null
  author: string | null
  published_at: string
}

type ClusterRow = {
  cluster_id: number
  size: number
  sources_count: number
  lead_article_id: number
  lead_title: string
  lead_url: string
  lead_dek: string | null
  lead_source: string | null
  lead_homepage: string | null
  lead_author: string | null
  published_at: string
  subs: Sub[]
}

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export default async function ClusterPage(props: {
  params: Promise<{ id: string }>
}) {
  const params = await props.params
  const cid = Number(params.id)

  const { rows } = await DB.query<ClusterRow>(
    `
    WITH lead AS (
      SELECT
        cs.cluster_id,
        cs.size,
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
      WHERE cs.cluster_id = $1::bigint
        AND a.canonical_url NOT LIKE 'https://news.google.com%'
        AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
        AND a.canonical_url NOT LIKE 'https://www.msn.com%'
      LIMIT 1
    )
    SELECT
      l.cluster_id,
      l.size,
      (SELECT COUNT(DISTINCT s.id)
         FROM article_clusters ac
         JOIN articles a2 ON a2.id = ac.article_id
         LEFT JOIN sources s ON s.id = a2.source_id
        WHERE ac.cluster_id = l.cluster_id)::int AS sources_count,
      l.lead_article_id,
      l.lead_title,
      l.lead_url,
      l.lead_dek,
      l.lead_source,
      l.lead_homepage,
      l.lead_author,
      l.published_at,

      (
        WITH x AS (
          SELECT
            a2.id            AS article_id,
            a2.title,
            a2.canonical_url AS url,
            COALESCE(a2.publisher_name, s2.name) AS source,
            a2.author,
            a2.published_at,
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
                    '\\\\s[-—]\\\\s[^-—]+$',
                    '',
                    'g'
                  ),
                  '[[:punct:]]',
                  ' ',
                  'g'
                ),
                '\\\\s+',
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
          -- exclude aggregators but show all articles including same source as lead
          SELECT 
            article_id, title, url, source, author, published_at
          FROM x
          WHERE url NOT LIKE 'https://news.google.com%'
            AND url NOT LIKE 'https://news.yahoo.com%'
            AND url NOT LIKE 'https://www.msn.com%'
            AND host_norm NOT IN ('news.google.com', 'news.yahoo.com', 'msn.com')
          ORDER BY
            published_at DESC
        ) y
      ) AS subs
    FROM lead l
    `,
    [cid]
  )

  const r = rows[0]
  if (!r) {
    return (
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-10 text-zinc-600">
        <Link href="/river" className="hover:underline">
          ← Back to river
        </Link>
        <p className="mt-6">Cluster not found.</p>
      </div>
    )
  }

  const leadClickHref = `/api/click?aid=${r.lead_article_id}&url=${encodeURIComponent(
    r.lead_url
  )}`

  return (
    <>
      <ArticleStructuredData
        headline={r.lead_title}
        description={r.lead_dek || undefined}
        datePublished={r.published_at}
        author={r.lead_author || undefined}
        publisher={r.lead_source || 'Climate River'}
        url={`https://climateriver.org/river/${cid}`}
      />
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-3">
        {/* Page chrome */}
        <div className="flex items-center justify-between text-[12px] sm:text-sm text-zinc-600">
          <Link href="/river" className="hover:underline">
            ← Back to river
          </Link>
          <span>
            {r.size} {r.size === 1 ? 'article' : 'articles'}
          </span>
        </div>

        {/* Lead article */}
        <article className="mt-4">
          <div className="text-xs text-zinc-500 mb-2">
            {r.lead_source ?? hostFrom(r.lead_url)}
          </div>

          <h1 className="text-xl font-semibold leading-tight mb-3 text-pretty">
            <a
              href={leadClickHref}
              className="text-zinc-900 hover:underline decoration-zinc-300"
            >
              {r.lead_title}
            </a>
          </h1>

          {r.lead_dek && (
            <p className="text-zinc-600 leading-relaxed mb-3 text-pretty">
              {r.lead_dek}
            </p>
          )}

          <div className="text-xs text-zinc-500">
            <LocalTime iso={r.published_at} />
          </div>
        </article>

        {/* Related articles */}
        {r.subs.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-zinc-500 mb-4">
              Related articles
            </h2>
            <ul className="flex flex-col gap-4 list-none">
              {r.subs.map((s) => {
                const href = `/api/click?aid=${s.article_id}&url=${encodeURIComponent(
                  s.url
                )}`
                return (
                  <li key={s.article_id}>
                    <div className="text-xs text-zinc-500 mb-1">
                      {s.source ?? hostFrom(s.url)}
                    </div>
                    <a
                      href={href}
                      className="block text-zinc-900 hover:underline decoration-zinc-300 leading-snug text-pretty"
                    >
                      {s.title}
                    </a>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </>
  )
}
