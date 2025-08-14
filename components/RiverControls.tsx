// components/RiverControls.tsx
'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import clsx from 'clsx'

export default function RiverControls({
  lastUpdated,
}: {
  lastUpdated?: string
}) {
  const pathname = usePathname() || '/river'
  const search = useSearchParams()
  const isLatest = search.get('view') === 'latest'

  const hrefTop = pathname
  const hrefLatest = `${pathname}?view=latest`

  return (
    <div className="w-full">
      <div className="flex items-center justify-between border-b border-zinc-200">
        {/* Left: Tabs */}
        <div className="flex items-end gap-4 sm:gap-6">
          <Tab href={hrefTop} active={!isLatest}>
            Top
          </Tab>
          <Tab href={hrefLatest} active={isLatest}>
            Latest
          </Tab>
        </div>

        {/* Right: Last updated - responsive */}
        {lastUpdated && (
          <div className="text-xs text-zinc-500 pb-1 hidden sm:block">
            Last updated {lastUpdated}
          </div>
        )}
      </div>

      {/* Mobile-only last updated below tabs */}
      {lastUpdated && (
        <div className="text-xs text-zinc-500 pt-2 sm:hidden">
          Last updated {lastUpdated}
        </div>
      )}
    </div>
  )
}

function Tab({
  href,
  active,
  children,
}: {
  href: string
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={clsx(
        'relative pb-1 px-1 text-sm sm:text-sm font-medium tracking-tight',
        'transition-colors text-zinc-500 hover:text-zinc-800',
        active && 'text-zinc-900'
      )}
      style={{ textDecoration: 'none' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
    >
      {children}
      {/* Active bar only (no secondary line to conflict with) */}
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none absolute left-0 right-0 bottom-[-1px] h-[2px]',
          active ? 'bg-zinc-900' : 'bg-transparent'
        )}
      />
    </Link>
  )
}
