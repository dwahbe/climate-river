// components/RiverControls.tsx
'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { CATEGORIES, type CategorySlug } from '@/lib/tagger'
import clsx from 'clsx'
import { CATEGORY_ICON_MAP } from '@/components/categoryIcons'

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
    <div className="w-full relative after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-0 after:h-px after:bg-zinc-200 after:pointer-events-none after:z-0">
      <div className="overflow-x-auto scrollbar-hide mobile-scroll">
        {/* baseline lives on the scrolling content */}
        <div className="flex min-w-full w-max whitespace-nowrap items-end gap-3 sm:gap-4">
          <span
            ref={(el) => {
              tabRefs.current['top'] = el
            }}
            onClick={() => ensureTabVisible('top')}
          >
            <Tab
              href={hrefTop}
              active={isTop}
              title="Top 10 climate stories ranked by our scoring algorithm"
            >
              Top
            </Tab>
          </span>
          <span
            ref={(el) => {
              tabRefs.current['latest'] = el
            }}
            onClick={() => ensureTabVisible('latest')}
          >
            <Tab
              href={hrefLatest}
              active={isLatest}
              title="Most recent 20 climate articles in reverse chronological order"
            >
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
                  slug={category.slug}
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
  title,
  children,
}: {
  href: string
  active?: boolean
  title?: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      title={title}
      className={clsx(
        'relative inline-block px-1 pb-[3px] text-sm font-medium tracking-tight whitespace-nowrap',
        'text-zinc-500 hover:text-zinc-800',
        "after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-0",
        'after:h-[2px] after:rounded after:transition-opacity after:opacity-0 after:z-10',
        active
          ? 'text-zinc-900 after:bg-zinc-900 after:opacity-100'
          : 'after:bg-transparent'
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
    </Link>
  )
}

function CategoryTab({
  href,
  active,
  color,
  title,
  children,
  slug,
}: {
  href: string
  active?: boolean
  color: string
  title?: string
  children: React.ReactNode
  slug: CategorySlug
}) {
  const Icon = CATEGORY_ICON_MAP[slug]

  return (
    <Link
      href={href}
      prefetch={false}
      title={title}
      className={clsx(
        'relative inline-block px-1 pb-[3px] text-sm font-medium tracking-tight whitespace-nowrap',
        'text-zinc-500 hover:text-zinc-800',
        "after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-0",
        'after:h-[2px] after:rounded after:transition-opacity after:bg-[var(--underline-color)] after:z-10',
        active ? 'text-zinc-900 after:opacity-100' : 'after:opacity-0'
      )}
      style={
        {
          textDecoration: 'none',
          '--underline-color': color,
        } as React.CSSProperties & { '--underline-color': string }
      }
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
    >
      {/* Icon - always rendered but invisible when not active to prevent layout shift */}
      {Icon && (
        <Icon
          className={clsx(
            'w-3.5 h-3.5 inline-block mr-1.5',
            active ? 'animate-popBounce' : 'opacity-0'
          )}
          style={{
            color: active ? color : 'transparent',
            verticalAlign: '-0.125em',
          }}
          aria-hidden
        />
      )}
      {children}
    </Link>
  )
}
