// components/RiverControls.tsx
'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import clsx from 'clsx'

export default function RiverControls() {
  const pathname = usePathname() || '/river'
  const search = useSearchParams()
  const isLatest = search.get('view') === 'latest'

  const hrefTop = pathname
  const hrefLatest = `${pathname}?view=latest`

  return (
    <div className="w-full">
      {/* Bottom-justified tabs, no global baseline */}
      <div className="flex items-end gap-8">
        <Tab href={hrefTop} active={!isLatest}>
          Top
        </Tab>
        <Tab href={hrefLatest} active={isLatest}>
          Latest
        </Tab>
      </div>
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
        'relative pb-3 no-underline text-lg font-medium tracking-tight',
        'transition-colors text-zinc-500 hover:text-zinc-900',
        active && 'text-zinc-900'
      )}
    >
      {children}
      {/* Active bar only (no secondary line to conflict with) */}
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none absolute left-0 right-0 bottom-0 h-[2px]',
          active ? 'bg-zinc-900' : 'bg-transparent'
        )}
      />
    </Link>
  )
}
