// app/layout.tsx
import './global.css'
import Link from 'next/link'
import * as DB from '@/lib/db'

export const dynamic = 'force-dynamic'

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // get latest “fetched_at” (fallback to now)
  const latest = await DB.query<{ ts: string }>(`
    select coalesce(max(fetched_at), now()) as ts
    from articles
  `)
  const ts = latest.rows[0]?.ts ?? new Date().toISOString()

  const lastFormatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date(ts))

  return (
    <html lang="en">
      <body>
        {/* top nav */}
        <nav
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
            padding: '16px 24px',
            borderBottom: '1px solid #e5e7eb',
            background: '#fff',
            position: 'sticky',
            top: 0,
            zIndex: 50,
          }}
        >
          {/* left: brand */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 9999,
                background: '#10938d', // teal dot
                display: 'inline-block',
              }}
            />
            <Link
              href="/"
              style={{
                textDecoration: 'none',
                color: '#0f172a',
                fontSize: 22,
                fontWeight: 700,
              }}
            >
              Climate River
            </Link>
          </div>

          {/* center: last updated */}
          <div
            style={{
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 12,
              letterSpacing: 0.2,
            }}
          >
            Last updated {lastFormatted}
          </div>

          {/* right: github */}
          <div style={{ textAlign: 'right' }}>
            <a
              href="https://github.com/dwahbe/climate-river-mvp"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#334155', textDecoration: 'none' }}
            >
              GitHub
            </a>
          </div>
        </nav>

        {/* page content */}
        {children}
      </body>
    </html>
  )
}
