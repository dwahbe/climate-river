// components/RiverControls.tsx
'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

function cx(...p: Array<string | false | null | undefined>) {
  return p.filter(Boolean).join(' ')
}

export default function RiverControls() {
  const pathname = usePathname()
  const search = useSearchParams()
  const view = search.get('view') === 'latest' ? 'latest' : 'top'

  const Tab = ({
    id,
    label,
    href,
  }: {
    id: 'top' | 'latest'
    label: string
    href: string
  }) => {
    const active = view === id
    return (
      <Link
        href={href}
        prefetch={false}
        replace
        scroll={false}
        role="tab"
        aria-selected={active}
        aria-current={active ? 'page' : undefined}
        className={cx(
          // touch target + spacing
          'px-2.5 sm:px-3 py-1.5 sm:py-2 rounded',
          // type
          'text-sm sm:text-[0.95rem] tracking-tight',
          // tone
          active
            ? 'text-zinc-900 font-medium'
            : 'text-zinc-500 hover:text-zinc-900',
          // a11y
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/10'
        )}
      >
        {label}
      </Link>
    )
  }

  const topHref = pathname
  const latestHref = `${pathname}?view=latest`

  return (
    <nav
      aria-label="View"
      role="tablist"
      className="mx-auto flex items-center justify-center gap-5 sm:gap-8"
    >
      <Tab id="top" label="Top" href={topHref} />
      <Tab id="latest" label="Latest" href={latestHref} />
    </nav>
  )
}
