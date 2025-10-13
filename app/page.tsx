import { getRiverData } from '@/lib/services/riverService'
import RiverClusterList from '@/components/RiverClusterList'
import type { Metadata } from 'next'

// Cache for 5 minutes (300 seconds)
export const revalidate = 300
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: 'Top Climate News',
  description:
    'Top climate news aggregated from leading outlets like The Guardian, New York Times, and Reuters. Stories organized by topic, ranked for trust and timeliness. Updated continuously.',
  openGraph: {
    title: 'Top Climate News | Climate River',
    description:
      'Top climate news aggregated from leading outlets. Stories organized by topic, ranked for trust and timeliness. Updated continuously.',
    url: 'https://climateriver.org',
    images: [
      {
        url: '/api/og',
        width: 1200,
        height: 630,
        alt: 'Climate River - Top climate news headlines',
      },
    ],
  },
  twitter: {
    title: 'Top Climate News | Climate River',
    description:
      'Top climate news aggregated from leading outlets. Stories organized by topic, ranked for trust and timeliness.',
    images: ['/api/og'],
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
