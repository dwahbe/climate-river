'use client'

export default function OpenAllButton({ urls }: { urls: string[] }) {
  // Safety: de-dupe & cap to avoid popup blockers
  const unique = Array.from(new Set(urls)).slice(0, 12)

  const openAll = () => {
    for (const u of unique) window.open(u, '_blank', 'noopener,noreferrer')
  }

  return (
    <button
      onClick={openAll}
      className="btn-ghost inline-flex items-center gap-2"
    >
      Open all sources
      <svg
        className="h-4 w-4"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M10 4h6m0 0v6m0-6L9 11" />
        <path d="M5 7v7a2 2 0 0 0 2 2h7" />
      </svg>
    </button>
  )
}
