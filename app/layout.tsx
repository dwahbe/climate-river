import './global.css'
import Link from 'next/link'
import { Analytics } from '@vercel/analytics/react'
import LastUpdated from '@/components/LastUpdated'
import HeaderLogoHover from '@/components/HeaderLogoHover'
import OrganizationStructuredData from '@/components/OrganizationStructuredData'
import { Inclusive_Sans } from 'next/font/google'

const inclusive = Inclusive_Sans({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-inclusive',
  display: 'swap',
})

export const metadata = {
  metadataBase: new URL('https://climateriver.org'),
  title: {
    default: 'Climate River - Climate News Aggregator',
    template: '%s | Climate River',
  },
  description:
    'Climate River aggregates climate news from The Guardian, New York Times, Reuters, and other trusted sources. Stories organized by topic, ranked for credibility and timeliness. Your focused source for climate change coverage.',
  keywords: [
    'climate change news',
    'climate news aggregator',
    'environmental news',
    'climate crisis',
    'global warming news',
    'climate policy',
    'renewable energy news',
    'climate journalism',
    'sustainability news',
    'climate change coverage',
  ],
  authors: [{ name: 'Dylan Wahbe', url: 'https://dylanwahbe.com' }],
  creator: 'Dylan Wahbe',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://climateriver.org',
    title: 'Climate River - Climate News Aggregator',
    description:
      'Climate River aggregates climate news from trusted sources like The Guardian, New York Times, and Reuters. Stories organized by topic, ranked for credibility and timeliness.',
    siteName: 'Climate River',
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
    card: 'summary_large_image',
    title: 'Climate River - Climate News Aggregator',
    description:
      'Climate news aggregated from The Guardian, NYT, Reuters, and more. Organized by story, ranked for trust.',
    creator: '@dylanwahbe',
    images: ['/api/og'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon.svg?v=2', type: 'image/svg+xml' }, // Cache-busting version
    ],
    shortcut: '/icon.svg?v=2',
    apple: '/apple-icon.png?v=2',
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inclusive.className}>
      <head>
        <OrganizationStructuredData />
      </head>
      <body className="min-h-full bg-zinc-50 text-zinc-900 antialiased">
        <nav className="bg-white border-b border-zinc-100">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            {/* Two columns: left / right — all vertically centered */}
            <div className="flex md:items-center md:justify-between max-md:flex-col gap-2 py-3 sm:py-4">
              {/* Left: brand + navigation */}
              <div className="flex items-baseline-last gap-6">
                <Link
                  href="/"
                  className="group flex items-center gap-2 no-underline"
                >
                  <HeaderLogoHover />
                  <span className="font-semibold text-base sm:text-lg">
                    Climate River
                  </span>
                </Link>

                <Link
                  href="/categories"
                  className="text-zinc-600 hover:text-zinc-900 no-underline"
                >
                  Categories
                </Link>

                <Link
                  href="/about"
                  className="text-zinc-600 hover:text-zinc-900 no-underline"
                >
                  About
                </Link>
              </div>

              {/* Right: Last updated */}
              <LastUpdated />
            </div>
          </div>
        </nav>

        <main className="mx-auto max-w-5xl md:px-4 py-6 content">
          {children}
        </main>

        <div className="pb-[env(safe-area-inset-bottom)]" />
        <Analytics />
      </body>
    </html>
  )
}
