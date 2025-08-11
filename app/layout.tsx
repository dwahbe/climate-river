// app/layout.tsx
import './global.css'
import Link from 'next/link'
import * as DB from '@/lib/db'

export const metadata = { title: 'Climate River' }
export const dynamic = 'force-dynamic'

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
        <nav className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-zinc-100">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3 sm:py-4 relative flex items-center">
            {/* Left: brand */}
            <Link href="/" className="flex items-center gap-2 nav-link">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
              <span className="font-semibold text-base sm:text-lg tracking-tight">
                Climate River
              </span>
            </Link>

            {/* Center: plain last-updated text (no box) */}
            <div className="absolute left-1/2 -translate-x-1/2 hidden sm:block text-xs sm:text-sm text-zinc-500">
              Last updated {lastFormatted}
            </div>

            {/* Right: GitHub */}
            <div className="ml-auto">
              <a
                href="https://github.com/dwahbe/climate-river-mvp"
                target="_blank"
                rel="noreferrer"
                className="btn-ghost"
              >
                GitHub
              </a>
            </div>
          </div>
        </nav>

        {/* Page container (links styled via .content in global.css) */}
        <main className="mx-auto max-w-5xl px-4 sm:px-6 py-6 content">
          {children}
        </main>

        <div className="pb-[env(safe-area-inset-bottom)]" />
      </body>
    </html>
  )
}
