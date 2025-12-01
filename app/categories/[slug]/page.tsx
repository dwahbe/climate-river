import Link from 'next/link'
import { notFound } from 'next/navigation'
import RiverClusterList from '@/components/RiverClusterList'
import { getRiverData } from '@/lib/services/riverService'
import { getCategoryBySlug, CATEGORIES } from '@/lib/tagger'
import { CategoryIcon } from '@/components/categoryIcons'
import BreadcrumbStructuredData from '@/components/BreadcrumbStructuredData'
import type { Metadata } from 'next'

export const revalidate = 300
export const runtime = 'nodejs'

export async function generateStaticParams() {
  return CATEGORIES.map((category) => ({
    slug: category.slug,
  }))
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const params = await props.params
  const category = getCategoryBySlug(params.slug)

  if (!category) {
    return {}
  }

  const title = `${category.name} Climate News`
  const description = `${category.description}. Stay updated with the latest ${category.name.toLowerCase()} news and developments in climate change.`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `https://climateriver.org/categories/${category.slug}`,
    },
    twitter: {
      title,
      description,
    },
    alternates: {
      canonical: `https://climateriver.org/categories/${category.slug}`,
    },
  }
}

export default async function CategoryDetailPage(props: {
  params: Promise<{ slug: string }>
}) {
  const params = await props.params
  const category = getCategoryBySlug(params.slug)

  if (!category) {
    notFound()
  }

  const clusters = await getRiverData({
    view: 'top',
    category: category.slug,
  })

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { name: 'Home', url: 'https://climateriver.org' },
          { name: 'Categories', url: 'https://climateriver.org/categories' },
          {
            name: category.name,
            url: `https://climateriver.org/categories/${category.slug}`,
          },
        ]}
      />
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10">
        <div className="text-sm text-zinc-500">
          <Link
            href="/categories"
            className="inline-flex items-center gap-1 hover:underline"
          >
            ← All categories
          </Link>
        </div>

      <div className="mt-4">
        <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 shadow-sm ring-1 ring-zinc-200">
          <span
            className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-zinc-100"
            style={{ color: category.color }}
          >
            <CategoryIcon
              slug={category.slug}
              className="h-3.5 w-3.5 text-current"
            />
          </span>
          <span>{category.name}</span>
        </div>
      </div>

      <div className="mt-6">
        <RiverClusterList clusters={clusters} />
      </div>
    </div>
    </>
  )
}
