// components/RiverControls.tsx
'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { CATEGORIES, type CategorySlug } from '@/lib/tagger'
import clsx from 'clsx'
import {
  Landmark,
  Megaphone,
  Briefcase,
  AlertTriangle,
  Zap,
  Microscope,
} from 'lucide-react'

// Map category slugs to their icons
const CATEGORY_ICONS = {
  government: Landmark,
  justice: Megaphone,
  business: Briefcase,
  impacts: AlertTriangle,
  tech: Zap,
  research: Microscope,
} as const

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
      <div className="overflow-x-auto overflow-y-hidden scrollbar-hide mobile-scroll">
        {/* baseline lives on the scrolling content */}
        <div className="flex min-w-full w-max whitespace-nowrap items-end gap-3 sm:gap-4 border-b border-zinc-200">
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
        'relative before:absolute before:content-[""] before:-inset-y-2 before:-inset-x-2 before:rounded pb-1 px-1 text-sm sm:text-sm font-medium',
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
          'pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] z-10 transform translate-y-[1px]',
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
  slug,
}: {
  href: string
  active?: boolean
  color: string
  title?: string
  children: React.ReactNode
  slug: CategorySlug
}) {
  const Icon = CATEGORY_ICONS[slug]

  return (
    <Link
      href={href}
      prefetch={false}
      title={title}
      className={clsx(
        'relative before:absolute before:content-[""] before:-inset-y-2 before:-inset-x-2 before:rounded pb-1 px-1 text-sm sm:text-sm font-medium whitespace-nowrap',
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
      {/* Icon - always rendered but invisible when not active to prevent layout shift */}
      {Icon && (
        <Icon
          className={clsx(
            'w-3.5 h-3.5 inline-block align-text-bottom mr-1.5',
            active ? 'animate-popBounce' : 'opacity-0'
          )}
          style={{ color: active ? color : 'transparent' }}
          aria-hidden
        />
      )}
      {children}
      {/* Active bar only (no secondary line to conflict with) */}
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] z-10 transform translate-y-[1px]',
          active ? 'opacity-100' : 'opacity-0'
        )}
        style={{ backgroundColor: active ? color : 'transparent' }}
      />
    </Link>
  )
}
