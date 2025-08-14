// components/RiverControls.tsx
'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import clsx from 'clsx'

function Tab({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'relative px-3 py-2 text-sm font-medium',
        'text-zinc-600 hover:text-zinc-900 transition-colors',
        active && 'text-zinc-900'
      )}
      aria-current={active ? 'page' : undefined}
    >
      <span>{children}</span>
      <span
        className={clsx(
          'absolute left-3 right-3 -bottom-[1px] h-[2px] rounded-full',
          active ? 'bg-zinc-900' : 'bg-transparent'
        )}
      />
    </button>
  )
}

export default function RiverControls() {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const view = search.get('view') === 'latest' ? 'latest' : 'top'

  const setView = (v: 'top' | 'latest') => {
    const q = new URLSearchParams(search.toString())
    if (v === 'top') q.delete('view')
    else q.set('view', 'latest')
    router.push(`${pathname}?${q.toString()}`)
  }

  return (
    <div>
      <div className="flex items-center justify-start gap-2">
        <Tab active={view === 'top'} onClick={() => setView('top')}>
          Top
        </Tab>
        <Tab active={view === 'latest'} onClick={() => setView('latest')}>
          Latest
        </Tab>
      </div>
      <div className="mt-2 h-px bg-zinc-200/60 rounded-full" />
    </div>
  )
}
