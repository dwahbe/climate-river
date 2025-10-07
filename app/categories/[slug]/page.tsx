import Link from 'next/link'
import { notFound } from 'next/navigation'
import RiverClusterList from '@/components/RiverClusterList'
import { getRiverData } from '@/lib/services/riverService'
import { getCategoryBySlug } from '@/lib/tagger'
import { CategoryIcon } from '@/components/categoryIcons'

export const revalidate = 300
export const runtime = 'nodejs'

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
            <CategoryIcon slug={category.slug} className="h-3.5 w-3.5 text-current" />
          </span>
          <span>{category.name}</span>
        </div>
      </div>

      <div className="mt-6">
        <RiverClusterList clusters={clusters} />
      </div>
    </div>
  )
}
