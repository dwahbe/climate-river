import { getRiverData } from '@/lib/services/riverService'
import RiverClusterList from '@/components/RiverClusterList'
import type { Metadata } from 'next'

// Cache for 5 minutes (300 seconds)
export const revalidate = 300
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Top Climate News',
  description:
    'The latest climate news stories aggregated from trusted sources. Updated continuously with breaking climate news, policy updates, and environmental reports.',
  openGraph: {
    title: 'Top Climate News | Climate River',
    description:
      'The latest climate news stories aggregated from trusted sources. Updated continuously.',
    url: 'https://climateriver.org',
  },
  twitter: {
    title: 'Top Climate News | Climate River',
    description:
      'The latest climate news stories aggregated from trusted sources. Updated continuously.',
  },
  alternates: {
    canonical: 'https://climateriver.org',
  },
}

export default async function RiverPage() {
  const clusters = await getRiverData({
    view: 'top',
  })

  return (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 pt-1 sm:pt-1.5">
      <h1 className="mb-3 text-xl font-semibold tracking-tight">Top news</h1>
      <RiverClusterList clusters={clusters} />
    </div>
  )
}
