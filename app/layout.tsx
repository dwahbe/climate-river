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
        <nav className="bg-white border-b border-zinc-100">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            {/* Two columns: left / right — all vertically centered */}
            <div className="flex items-center justify-between py-3 sm:py-4">
              {/* Left: brand + navigation */}
              <div className="flex items-center gap-6">
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

              {/* Right: Last updated - Desktop only */}
              <div className="hidden sm:block text-xs text-zinc-500">
                Last updated{' '}
                {new Date().toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}{' '}
                at{' '}
                {new Date().toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </div>
            </div>
          </div>
        </nav>

        {/* Mobile: Last updated below navbar */}
        <div className="sm:hidden bg-white border-b border-zinc-100">
          <div className="mx-auto max-w-5xl px-4">
            <div className="py-2 text-center text-xs text-zinc-500">
              Last updated{' '}
              {new Date().toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}{' '}
              at{' '}
              {new Date().toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}
            </div>
          </div>
        </div>

        <main className="mx-auto max-w-5xl px-4 sm:px-6 py-6 content">
          {children}
        </main>

        <div className="pb-[env(safe-area-inset-bottom)]" />
        <Analytics />
      </body>
    </html>
  )
}
