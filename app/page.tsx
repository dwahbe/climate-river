import Link from 'next/link'
import LocalTime from '@/components/LocalTime'
import RiverControls from '@/components/RiverControls'
import PublisherLink from '@/components/PublisherLink'
import SourceTooltip from '@/components/SourceTooltip'
import { CATEGORIES } from '@/lib/tagger'
import { getRiverData } from '@/lib/services/riverService'

// Cache for 5 minutes (300 seconds)
export const revalidate = 300
export const runtime = 'nodejs'

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

  const view = Array.isArray(searchParams?.view)
    ? searchParams?.view[0]
    : searchParams?.view

  // Check if it's a category view
  const selectedCategory = CATEGORIES.find((c) => c.slug === view)?.slug

  // Fetch data using the service layer
  const clusters = await getRiverData({
    view: view || 'top',
    category: selectedCategory,
  })

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
          {clusters.map((r) => {
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

                <h3 className="text-[18px] sm:text-[19px] md:text-[20px] font-semibold leading-snug text-pretty">
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
