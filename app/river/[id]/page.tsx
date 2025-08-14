// app/river/[id]/page.tsx
import Link from 'next/link'
import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'
import OpenAllButton from '@/components/OpenAllButton'
import { unstable_noStore as noStore } from 'next/cache'
import Card from '@/components/ui/Card'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

export default async function ClusterPage({
  params,
}: {
  params: { id: string }
}) {
  noStore()
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
              lower(regexp_replace(COALESCE(a2.publisher_homepage, a2.canonical_url),
                    '^https?://(www\\.)?([^/]+).*$', '\\\\2'))
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
        SELECT COALESCE(json_agg(row_to_json(y) ORDER BY y.published_at DESC), '[]'::json)
        FROM (
          -- keep one per outlet, prefer real outlet to Google, then newest
          SELECT DISTINCT ON (host_norm)
            article_id, title, url, source, author, published_at
          FROM x
          ORDER BY
            host_norm,
            (url NOT LIKE 'https://news.google.com%') DESC,
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
  const openAllUrls = [r.lead_url, ...r.subs.map((s) => s.url)]

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-5">
      {/* Page chrome */}
      <div className="flex items-center justify-between text-[12px] sm:text-sm text-zinc-600">
        <Link href="/river" className="hover:underline">
          ← Back to river
        </Link>
        <span>
          {r.size} {r.size === 1 ? 'article' : 'articles'}
        </span>
      </div>

      {/* Lead card */}
      <Card className="mt-4">
        <div className="text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500 mb-1.5">
          {r.lead_source ?? hostFrom(r.lead_url)}
        </div>

        <h1 className="text-xl sm:text-[22px] font-semibold tracking-tight leading-snug">
          <a
            href={leadClickHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-950 hover:text-zinc-900 focus-visible:focus-ring rounded transition"
          >
            {r.lead_title}
          </a>
        </h1>

        {r.lead_dek && (
          <p className="mt-2 text-[15px] sm:text-base text-zinc-600">
            {r.lead_dek}
          </p>
        )}

        <div className="mt-3 flex items-center gap-3 text-[12px] sm:text-sm text-zinc-500">
          <LocalTime iso={r.published_at} />
          <span className="ml-auto" />
          <OpenAllButton
            urls={openAllUrls}
            className="text-zinc-700 hover:text-zinc-900"
          />
        </div>
      </Card>

      {/* More coverage */}
      {r.subs.length > 0 && (
        <Card className="mt-5">
          <div className="mb-2 text-[13px] font-medium text-zinc-500">
            More coverage
          </div>
          <ul className="divide-y divide-zinc-200/70">
            {r.subs.map((s) => {
              const href = `/api/click?aid=${s.article_id}&url=${encodeURIComponent(
                s.url
              )}`
              return (
                <li key={s.article_id} className="py-3">
                  <div className="mb-1 text-[11px] sm:text-xs text-zinc-500">
                    {s.source ?? hostFrom(s.url)}
                  </div>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[15px] sm:text-base text-zinc-900 hover:underline decoration-zinc-300"
                  >
                    {s.title}
                  </a>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}
