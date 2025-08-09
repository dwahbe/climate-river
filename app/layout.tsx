import './global.css'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

export const metadata = {
  title: 'Climate River',
  description: 'A modern, neutral climate news river.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.className}>
      <body>
        <header className="header">
          <div className="brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="1.5"
                opacity="0.5"
              />
              <path
                d="M4 14c3-1 5-4 8-4s5 3 8 4"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
            Climate River
            <span className="badge">MVP</span>
          </div>
          <nav style={{ display: 'flex', gap: 12 }}>
            <a href="/river">River</a>
          </nav>
        </header>
        <div className="container">{children}</div>
        <div className="container footer">
          Built for speed. Neutral by default.
        </div>
      </body>
    </html>
  )
}
