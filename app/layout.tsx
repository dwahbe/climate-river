import './global.css'

export const metadata = {
  title: 'Climate River',
  description: 'Neutral climate news river',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="1.4"
                opacity="0.5"
              />
              <path
                d="M4 14c3-1 5-4 8-4s5 3 8 4"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
            Climate River <span className="badge">MVP</span>
          </div>
          <nav>
            <a href="/river">River</a>
          </nav>
        </header>
        <div className="container">{children}</div>
        <footer className="container footer">
          Built for speed. Neutral by default.
        </footer>
      </body>
    </html>
  )
}
