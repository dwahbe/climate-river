import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  Landmark,
  Megaphone,
  Factory,
  AlertTriangle,
  Zap,
  Microscope,
} from 'lucide-react'
import ClimateRiverLogo from '@/components/ClimateRiverLogo'
import { CATEGORIES, type CategorySlug } from '@/lib/tagger'
import { CategoryIcon } from '@/components/categoryIcons'
import { getRiverData } from '@/lib/services/riverService'

const CATEGORY_ICONS: Record<CategorySlug, LucideIcon> = {
  government: Landmark,
  justice: Megaphone,
  business: Factory,
  impacts: AlertTriangle,
  tech: Zap,
  research: Microscope,
}

export const runtime = 'nodejs'

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export default async function CategoriesPage() {
  const categoryStreams = await Promise.all(
    CATEGORIES.map(async (category) => {
      const clusters = await getRiverData({
        view: 'top',
        category: category.slug,
        limit: 5,
      })

      return {
        category,
        clusters,
      }
    })
  )

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-2 sm:pt-2.5 pb-8 content">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {CATEGORIES.map((category) => {
              const Icon = CATEGORY_ICONS[category.slug]
              if (!Icon) return null

              const tooltipId = `categories-page-${category.slug}-tooltip`

              return (
                <span
                  key={category.slug}
                  tabIndex={0}
                  className="relative group inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-300 focus-visible:rounded-full"
                  aria-label={`${category.name}: ${category.description}`}
                  aria-describedby={tooltipId}
                  role="img"
                >
                  <Icon
                    className="w-5 h-5 transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110"
                    style={{ color: category.color }}
                    aria-hidden="true"
                    focusable="false"
                  />
                  <span
                    id={tooltipId}
                    className="pointer-events-none absolute left-1/2 bottom-full z-10 mb-2 w-max max-w-xs -translate-x-1/2 rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                    role="tooltip"
                  >
                    <span className="block">{category.name}</span>
                    <span className="mt-0.5 block text-[0.675rem] font-normal text-zinc-100/80">
                      {category.description}
                    </span>
                  </span>
                </span>
              )
            })}
          </div>

          <div className="w-px h-6 bg-zinc-300" />

          <ClimateRiverLogo size="lg" variant="colored" animated={true} />
        </div>
      </div>

      <p className="mt-3 text-sm text-zinc-600">
        Explore the climate beats where we curate the most consequential reporting in real time.
      </p>

      <div className="mt-8 divide-y divide-zinc-200/70">
        {categoryStreams.map(({ category, clusters }) => (
          <section
            key={category.slug}
            className="py-8 first:pt-0 last:pb-0 sm:py-10"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-zinc-100"
                  style={{ color: category.color }}
                >
                  <CategoryIcon slug={category.slug} className="h-4 w-4 text-current" />
                </span>
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-zinc-900">
                    {category.name}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-500">
                    {category.description}
                  </p>
                </div>
              </div>
              <Link
                href={`/categories/${category.slug}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-sky-600 hover:text-sky-700 whitespace-nowrap"
              >
                View top stories <span aria-hidden="true">→</span>
              </Link>
            </div>

            <ol className="mt-5 space-y-2.5 list-none">
              {clusters.length > 0 ? (
                clusters.slice(0, 5).map((cluster, index) => {
                  const leadHref = `/api/click?aid=${cluster.lead_article_id}&url=${encodeURIComponent(
                    cluster.lead_url
                  )}`
                  const source = cluster.lead_source || hostFrom(cluster.lead_url)

                  return (
                    <li
                      key={cluster.cluster_id}
                      className="flex gap-3"
                    >
                      <span className="mt-0.5 text-xs font-medium text-zinc-400 tabular-nums leading-6">
                        {index + 1}.
                      </span>
                      <div>
                        <a
                          href={leadHref}
                          className="text-sm font-medium leading-snug text-zinc-900 hover:underline decoration-zinc-300 hover:decoration-zinc-500"
                        >
                          {cluster.lead_title}
                        </a>
                        <p className="mt-1 text-[11px] uppercase tracking-[0.28em] text-zinc-400">
                          {source}
                        </p>
                      </div>
                    </li>
                  )
                })
              ) : (
                <li className="text-sm text-zinc-500">
                  No elevated stories at the moment. Check back soon.
                </li>
              )}
            </ol>
          </section>
        ))}
      </div>
    </div>
  )
}
