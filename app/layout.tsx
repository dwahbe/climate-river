// app/layout.tsx
import './global.css'
import Link from 'next/link'
import * as DB from '@/lib/db'
import { Analytics } from '@vercel/analytics/react'

export const metadata = {
  title: 'Climate River',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/apple-icon.png',
  },
}
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-zinc-50 text-zinc-900 antialiased">
        <nav className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-zinc-100">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            {/* Two columns: left / right — all vertically centered */}
            <div className="flex items-center justify-between py-3 sm:py-4">
              {/* Left: brand + mini nav */}
              <div className="flex items-center gap-4">
                <Link href="/" className="flex items-center gap-2 no-underline">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
                  <span className="font-semibold text-base sm:text-lg tracking-tight">
                    Climate River
                  </span>
                </Link>
                {/* Desktop navigation */}
                <div className="hidden sm:flex items-baseline gap-3 text-sm">
                  <Link
                    href="/"
                    className="text-zinc-600 hover:text-zinc-900 no-underline"
                  >
                    Home
                  </Link>
                  <span className="text-zinc-300">/</span>
                  <Link
                    href="/about"
                    className="text-zinc-600 hover:text-zinc-900 no-underline"
                  >
                    About
                  </Link>
                </div>

                {/* Mobile navigation */}
                <div className="flex sm:hidden items-center">
                  <Link
                    href="/about"
                    className="text-zinc-600 hover:text-zinc-900 no-underline text-sm"
                  >
                    About
                  </Link>
                </div>
              </div>

              {/* Right: GitHub icon */}
              <div>
                <a
                  href="https://github.com/dwahbe/climate-river-mvp"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub repository"
                  title="GitHub"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/10"
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className="h-5 w-5"
                  >
                    <path
                      fill="currentColor"
                      d="M12 .5a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58l-.01-2.04c-3.35.73-4.06-1.6-4.06-1.6-.55-1.38-1.34-1.75-1.34-1.75-1.1-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.08 1.85 2.83 1.32 3.52 1.01.11-.78.42-1.32.76-1.62-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.53.1-3.18 0 0 1.01-.32 3.31 1.23.96-.27 1.98-.4 3-.41 1.02.01 2.04.14 3 .41 2.3-1.55 3.31-1.23 3.31-1.23.64 1.65.23 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.62-2.81 5.63-5.49 5.93.43.36.82 1.08.82 2.18l-.01 2.62c0 .32.21.69.83.57A12 12 0 0 0 12 .5Z"
                    />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </nav>

        <main className="mx-auto max-w-5xl px-4 sm:px-6 py-6 content">
          {children}
        </main>

        <div className="pb-[env(safe-area-inset-bottom)]" />
        <Analytics />
      </body>
    </html>
  )
}
