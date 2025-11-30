'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

type Article = {
  article_id: number
  title: string
  url: string
  author: string | null
}

type SourceTooltipProps = {
  sourceName: string
  articles: Article[]
  children: React.ReactNode
}

export default function SourceTooltip({
  sourceName,
  articles,
  children,
}: SourceTooltipProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const timeoutRef = useRef<NodeJS.Timeout>(undefined)
  const hideTimeoutRef = useRef<NodeJS.Timeout>(undefined)
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Don't show tooltip on mobile/touch devices
  const [isTouchDevice, setIsTouchDevice] = useState(false)

  // Memoize updateTooltipPosition to avoid recreating it on every render
  const updateTooltipPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const viewportWidth =
        window.innerWidth || document.documentElement.clientWidth

      // Calculate position with edge detection
      let x = rect.left + rect.width / 2
      const tooltipWidth = 256 // approximate tooltip width

      // Adjust if tooltip would go off-screen
      if (x + tooltipWidth / 2 > viewportWidth - 16) {
        x = viewportWidth - tooltipWidth / 2 - 16
      } else if (x - tooltipWidth / 2 < 16) {
        x = tooltipWidth / 2 + 16
      }

      setPosition({
        x,
        y: rect.bottom + 8, // 8px gap below the source
      })
      setIsVisible(true)
    }
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hasTouch =
        'ontouchstart' in window ||
        (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
      // Determine touch capability after mount to avoid hydration mismatches.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsTouchDevice(hasTouch)
    }

    // Add scroll listener to update tooltip position
    const handleScroll = () => {
      if (isVisible) {
        updateTooltipPosition()
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [isVisible, updateTooltipPosition])

  const handleMouseEnter = () => {
    if (isTouchDevice || !articles || articles.length === 0) return

    // Clear any existing hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = undefined
    }

    // Set show timeout
    timeoutRef.current = setTimeout(() => {
      updateTooltipPosition()
    }, 300)
  }

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
    }

    // Small delay before hiding to allow mouse to move to tooltip
    hideTimeoutRef.current = setTimeout(() => {
      setIsVisible(false)
    }, 150)
  }

  const handleTooltipMouseEnter = () => {
    // Keep tooltip visible when hovering over it
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = undefined
    }
  }

  const handleTooltipMouseLeave = () => {
    // Hide immediately when leaving tooltip
    setIsVisible(false)
  }

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    }
  }, [])

  // Don't render tooltip wrapper if conditions aren't met
  if (isTouchDevice || !articles || articles.length === 0) {
    return <>{children}</>
  }

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline cursor-default"
        aria-label={sourceName}
      >
        {children}
      </div>

      {isVisible && (
        <div
          ref={tooltipRef}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
          className="fixed z-50 bg-white rounded shadow-sm border border-zinc-200 p-3 max-w-[min(calc(100vw-32px),24rem)] w-auto min-w-60 sm:min-w-64"
          style={{
            left: position.x,
            top: position.y,
            transform: 'translateX(-50%)', // Center horizontally
          }}
          aria-live="polite"
          role="status"
        >
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {sourceName}
            </div>
            <div className="space-y-3">
            {articles.map((article) => (
              <div key={article.article_id} className="space-y-1">
                <a
                  href={`/api/click?aid=${article.article_id}&url=${encodeURIComponent(article.url)}`}
                  className="text-sm text-zinc-900 hover:text-zinc-600 leading-relaxed block transition-colors text-pretty"
                >
                  {article.title}
                </a>
                {article.author && (
                  <div className="text-xs text-zinc-500 font-normal leading-tight">
                    by {article.author}
                  </div>
                )}
              </div>
            ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
