import Link from 'next/link'

export default function Home() {
  return (
    <div className="wrap" style={{ padding: '28px 0 56px' }}>
      <h1 style={{ margin: '6px 0 10px' }}>Climate River</h1>
      <p style={{ color: '#555', maxWidth: 680 }}>
        A single, neutral stream of the most important climate and
        climate-justice stories, ranked by momentum and corroboration.
      </p>
      <p style={{ marginTop: 20 }}>
        <Link
          href="/river"
          style={{
            background: '#1b7f6e',
            color: '#fff',
            padding: '10px 14px',
            borderRadius: 8,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Open the River →
        </Link>
      </p>
    </div>
  )
}
