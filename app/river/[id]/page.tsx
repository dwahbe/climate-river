// app/river/[id]/page.tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import * as DB from '@/lib/db'
import OpenAllButton from '@/components/OpenAllButton' // make sure this file exists

export const dynamic = 'force-dynamic'

type Article = {
  id: number
  title: string
  rewritten_title: string | null
  canonical_url: string
  published_at: string
  source_name: string | null
  source_homepage: string | null
  dek: string | null
}

type Cluster = {
  cluster_id: number
  size: number
  score: number
  lead: Article
  others: Article[]
}

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

async function getCluster(clusterId: number): Promise<Cluster | null> {
  const { rows } = await DB.query<{
    cluster_id: number
    size: number
    score: number
    is_lead: boolean
    id: number
    title: string
    rewritten_title: string | null
    canonical_url: string
    published_at: string
    source_name: string | null
    source_homepage: string | null
    dek: string | null
  }>(
    `
    with ranked as (
      select
        cs.cluster_id,
        cs.size,
        cs.score,
        (a.id = cs.lead_article_id) as is_lead,
        a.id,
        a.title,
        a.rewritten_title,
        a.canonical_url,
        a.published_at,
        s.name as source_name,
        s.homepage_url as source_homepage,
        a.dek
      from cluster_scores cs
      join article_clusters ac on ac.cluster_id = cs.cluster_id
      join articles a on a.id = ac.article_id
      left join sources s on s.id = a.source_id
      where cs.cluster_id = $1
    )
    select * from ranked
    order by is_lead desc, published_at desc
    `,
    [clusterId]
  )

  if (rows.length === 0) return null

  const leadRow = rows.find((r) => r.is_lead) ?? rows[0]
  const others = rows.filter((r) => r.id !== leadRow.id)

  const toArticle = (r: (typeof rows)[number]): Article => ({
    id: r.id,
    title: r.title,
    rewritten_title: r.rewritten_title,
    canonical_url: r.canonical_url,
    published_at: r.published_at,
    source_name: r.source_name,
    source_homepage: r.source_homepage,
    dek: r.dek,
  })

  return {
    cluster_id: leadRow.cluster_id,
    size: leadRow.size,
    score: leadRow.score,
    lead: toArticle(leadRow),
    others: others.map(toArticle),
  }
}

export default async function ClusterPage({
  params,
}: {
  params: { id: string }
}) {
  const idNum = Number(params.id)
  if (!Number.isFinite(idNum)) notFound()

  const data = await getCluster(idNum)
  if (!data) notFound()

  const { lead, others, size } = data
  const leadPublisher =
    lead.source_name || hostFrom(lead.canonical_url) || 'Source'

  return (
    <section className="mx-auto max-w-3xl md:max-w-4xl lg:max-w-5xl px-4 sm:px-6 py-6">
      {/* Back + header */}
      <div className="mb-5 flex items-center justify-between">
        <Link
          href="/river"
          className="text-sm text-zinc-600 hover:text-zinc-900"
        >
          ← Back to river
        </Link>
        <div className="text-xs text-zinc-500">
          {size} {size === 1 ? 'article' : 'articles'}
        </div>
      </div>

      {/* Lead card */}
      <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="mb-1 text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500">
          {lead.source_homepage ? (
            <a
              href={lead.source_homepage}
              target="_blank"
              rel="noreferrer"
              className="hover:text-zinc-700 no-underline"
            >
              {leadPublisher}
            </a>
          ) : (
            leadPublisher
          )}
        </div>

        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight leading-snug">
          <a
            href={lead.canonical_url}
            target="_blank"
            rel="noreferrer"
            className="no-underline hover:underline decoration-zinc-300"
          >
            {lead.rewritten_title || lead.title}
          </a>
        </h1>

        {lead.dek && (
          <p className="mt-2 text-zinc-700 text-[0.95rem]">{lead.dek}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <OpenAllButton
            urls={[lead.canonical_url, ...others.map((o) => o.canonical_url)]}
          />
        </div>
      </article>

      {/* Others */}
      {others.length > 0 && (
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-4">
          <div className="mb-3 text-sm font-medium text-zinc-700">
            More coverage
          </div>
          <ul className="space-y-3">
            {others.map((a) => {
              const pub = a.source_name || hostFrom(a.canonical_url)
              return (
                <li
                  key={a.id}
                  className="border-b last:border-0 border-zinc-100 pb-3"
                >
                  <div className="text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500 mb-0.5">
                    {pub}
                  </div>
                  <a
                    href={a.canonical_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[15px] sm:text-[16px] font-medium text-zinc-900 no-underline hover:underline decoration-zinc-300"
                  >
                    {a.rewritten_title || a.title}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
