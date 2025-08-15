'use client'
type Props = {
  urls: string[]
  className?: string
}

export default function OpenAllButton({ urls, className }: Props) {
  // Safety: de-dupe & cap to avoid popup blockers
  const unique = Array.from(new Set(urls)).slice(0, 12)

  const openAll = () => {
    // Open first URL in current tab
    if (unique.length > 0) {
      window.location.href = unique[0]
    }
  }

  return (
    <button
      onClick={openAll}
      className="btn-ghost inline-flex items-center gap-2"
    >
      Open first source
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
