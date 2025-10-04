import './global.css'
import Link from 'next/link'
import { Analytics } from '@vercel/analytics/react'
import LastUpdated from '@/components/LastUpdated'
import ClimateRiverLogo from '@/components/ClimateRiverLogo'
import { Inclusive_Sans } from 'next/font/google'

const inclusive = Inclusive_Sans({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-inclusive',
  display: 'swap',
})

export const metadata = {
  title: 'Climate River',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/apple-icon.png',
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inclusive.className}>
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
                  <span className="relative inline-flex" aria-hidden="true">
                    <ClimateRiverLogo
                      size="lg"
                      variant="monochrome"
                      animated={false}
                      className="transition-opacity duration-200 ease-out group-hover:opacity-0 group-focus-visible:opacity-0"
                    />
                    <ClimateRiverLogo
                      size="lg"
                      variant="colored"
                      animated={false}
                      className="absolute inset-0 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </span>
                  <span className="font-semibold text-base sm:text-lg">
                    Climate River
                  </span>
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
