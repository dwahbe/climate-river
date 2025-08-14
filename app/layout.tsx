// app/layout.tsx
import './global.css'
import Link from 'next/link'
import * as DB from '@/lib/db'
import { Analytics } from '@vercel/analytics/react'

export const metadata = { title: 'Climate River' }
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const latest = await DB.query<{ ts: string }>(`
    select coalesce(max(fetched_at), now()) as ts
    from articles
  `)
  const lastTs = latest.rows[0]?.ts ?? new Date().toISOString()
  const lastFormatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date(lastTs))

  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-zinc-50 text-zinc-900 antialiased">
        <nav
          className="sticky top-0 z-30 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 border-b border-zinc-100"
          aria-label="Primary"
        >
          <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3 sm:py-4 relative flex items-center">
            {/* Left: brand */}
            <Link href="/" className="flex items-center gap-2 nav-link">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
              <span className="font-semibold text-base sm:text-lg tracking-tight">
                Climate River
              </span>
            </Link>

            {/* Lightweight site nav (kept subtle) */}
            <div className="ml-4 hidden sm:flex items-center gap-3 text-sm">
              <Link href="/river" className="text-zinc-600 hover:text-zinc-900">
                River
              </Link>
              <span className="text-zinc-300">/</span>
              <Link href="/about" className="text-zinc-600 hover:text-zinc-900">
                About
              </Link>
            </div>

            {/* Center: last-updated text */}
            <div
              className="absolute left-1/2 -translate-x-1/2 hidden sm:block text-xs sm:text-sm text-zinc-500"
              aria-live="polite"
            >
              Last updated {lastFormatted}
            </div>

            {/* Right: GitHub */}
            <div className="ml-auto">
              <a
                href="https://github.com/dwahbe/climate-river-mvp"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub repository"
                title="GitHub"
                className="icon-btn"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
                  <path
                    fill="currentColor"
                    d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385..."
                  />
                </svg>
                <span className="sr-only">GitHub</span>
              </a>
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
