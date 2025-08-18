// components/RiverControls.tsx
'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { CATEGORIES, type CategorySlug } from '@/lib/tagger'
import clsx from 'clsx'

interface RiverControlsProps {
  currentView?: string
  selectedCategory?: CategorySlug
}

export default function RiverControls({
  currentView,
  selectedCategory,
}: RiverControlsProps) {
  const pathname = usePathname() || '/river'

  const isTop = !currentView || currentView === 'top'
  const isLatest = currentView === 'latest'
  const isCategory = !!selectedCategory

  // Create hrefs for all tabs
  const hrefTop = pathname
  const hrefLatest = `${pathname}?view=latest`

  const tabRefs = useRef<Record<string, HTMLSpanElement | null>>({})

  const ensureTabVisible = (tabKey: string) => {
    const tabElement = tabRefs.current[tabKey]
    if (tabElement) {
      tabElement.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
  }

  useEffect(() => {
    let activeTabKey = 'top'
    if (isLatest) activeTabKey = 'latest'
    else if (selectedCategory) activeTabKey = selectedCategory

    ensureTabVisible(activeTabKey)
  }, [isLatest, selectedCategory])

  return (
    <div className="w-full">
      <div className="overflow-x-auto scrollbar-hide scroll-smooth">
        {/* baseline lives on the scrolling content */}
        <div className="flex min-w-full w-max whitespace-nowrap items-end gap-4 sm:gap-6 border-b border-zinc-200">
          <span
            ref={(el) => {
              tabRefs.current['top'] = el
            }}
            onClick={() => ensureTabVisible('top')}
          >
            <Tab href={hrefTop} active={isTop}>
              Top
            </Tab>
          </span>
          <span
            ref={(el) => {
              tabRefs.current['latest'] = el
            }}
            onClick={() => ensureTabVisible('latest')}
          >
            <Tab href={hrefLatest} active={isLatest}>
              Latest
            </Tab>
          </span>

          {/* Divider */}
          <div className="w-px h-4 bg-zinc-300 mx-2" />

          {/* Category tabs */}
          {CATEGORIES.map((category) => {
            const href = `${pathname}?view=${category.slug}`
            const isActive = selectedCategory === category.slug
            return (
              <span
                key={category.slug}
                ref={(el) => {
                  tabRefs.current[category.slug] = el
                }}
                onClick={() => ensureTabVisible(category.slug)}
              >
                <CategoryTab
                  href={href}
                  active={isActive}
                  color={category.color}
                  title={category.description}
                >
                  {category.name}
                </CategoryTab>
              </span>
            )
          })}
        </div>
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

function CategoryTab({
  href,
  active,
  color,
  title,
  children,
}: {
  href: string
  active?: boolean
  color: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      title={title}
      className={clsx(
        'relative pb-1 px-1 text-sm sm:text-sm font-medium tracking-tight whitespace-nowrap',
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
          active ? 'opacity-100' : 'opacity-0'
        )}
        style={{ backgroundColor: active ? color : 'transparent' }}
      />
    </Link>
  )
}
