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
import { CATEGORIES, type CategorySlug } from '@/lib/tagger'
import { CategoryIcon } from '@/components/categoryIcons'
import { getRiverData } from '@/lib/services/riverService'
import type { Metadata } from 'next'

const CATEGORY_ICONS: Record<CategorySlug, LucideIcon> = {
  government: Landmark,
  justice: Megaphone,
  business: Factory,
  impacts: AlertTriangle,
  tech: Zap,
  research: Microscope,
}

export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Categories',
  description:
    'Explore climate news by category: Government policy and regulations, Activism and protests, Business and corporate action, Climate impacts and extreme weather, Clean technology and renewables, Research and scientific discoveries.',
  openGraph: {
    title: 'Climate News Categories',
    description:
      'Explore climate news organized by category: Government, Activism, Business, Impacts, Tech, and Research.',
    url: 'https://climateriver.org/categories',
  },
  twitter: {
    title: 'Climate News Categories',
    description: 'Explore climate news organized by category.',
  },
  alternates: {
    canonical: 'https://climateriver.org/categories',
  },
}

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
    <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-1 sm:pt-1.5 pb-8 content overflow-x-hidden">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Categories</h1>
        <div className="flex items-center gap-2">
          {CATEGORIES.map((category) => {
            const Icon = CATEGORY_ICONS[category.slug]
            if (!Icon) return null

            return (
              <span
                key={category.slug}
                className="inline-flex items-center"
                aria-label={`${category.name}: ${category.description}`}
                role="img"
              >
                <Icon
                  className="w-5 h-5"
                  style={{ color: category.color }}
                  aria-hidden="true"
                  focusable="false"
                />
              </span>
            )
          })}
          {/* <div className="w-px h-6 bg-zinc-300" /> */}
          {/* <ClimateRiverLogo size="lg" variant="colored" animated={true} /> */}
        </div>
      </div>

      <p className="mt-3 text-sm text-zinc-600">
        Explore the climate beats where we curate the most consequential
        reporting in real time.
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
                  <CategoryIcon
                    slug={category.slug}
                    className="h-4 w-4 text-current"
                  />
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
                className="inline-flex items-center gap-1 text-sm font-medium text-sky-600 hover:text-sky-700 flex-shrink-0"
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
                  const source =
                    cluster.lead_source || hostFrom(cluster.lead_url)

                  return (
                    <li key={cluster.cluster_id} className="flex gap-3">
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
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-zinc-400 break-all">
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
