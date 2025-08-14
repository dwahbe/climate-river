// app/layout.tsx
import './global.css'
import Link from 'next/link'
import * as DB from '@/lib/db'
import { Analytics } from '@vercel/analytics/react' // ✅ correct entrypoint

export const metadata = { title: 'Climate River' }
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs' // ✅ ensure Node for DB access

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

            {/* Center: last-updated text */}
            <div className="absolute left-1/2 -translate-x-1/2 hidden sm:block text-xs sm:text-sm text-zinc-500">
              Last updated {lastFormatted}
            </div>

            {/* Right: GitHub */}
            <div className="ml-auto">
              <a
                href="https://github.com/dwahbe/climate-river-mvp"
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub repository"
                title="GitHub"
                className="icon-btn"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
                  <path
                    fill="currentColor"
                    d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577
           0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7
           c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305
           3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38
           1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405
           1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176
           .765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22
           0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297
           c0-6.627-5.373-12-12-12"
                  />
                </svg>
                <span className="sr-only">GitHub</span>
              </a>
            </div>
          </div>
        </nav>

        {/* Page container */}
        <main className="mx-auto max-w-5xl px-4 sm:px-6 py-6 content">
          {children}
        </main>

        <div className="pb-[env(safe-area-inset-bottom)]" />
        <Analytics />
      </body>
    </html>
  )
}
