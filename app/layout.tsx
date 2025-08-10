import './global.css'

export const metadata = {
  title: 'Climate River',
  description: 'A minimal, neutral climate news stream.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <header className="head">
          <div className="container">
            <a className="brand" href="/">
              <span className="seed" />
              Climate&nbsp;River
            </a>
            <nav className="nav">
              <a href="/river">River</a>
              <a
                href="https://github.com/dwahbe/climate-river-mvp"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </nav>
          </div>
        </header>
        <main className="main">{children}</main>
        <footer className="foot">
          <div className="container">
            Neutral by default • Updates automatically
          </div>
        </footer>
      </body>
    </html>
  )
}
