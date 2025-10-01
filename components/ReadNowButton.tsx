'use client'

import { useState } from 'react'
import ReaderView from './ReaderView'

type ReadNowButtonProps = {
  articleId: number
  articleTitle: string
  articleUrl: string
  disabled?: boolean
  contentStatus?: string | null
  contentWordCount?: number | null
}

/**
 * Determines if reader content is available and usable
 * Hides button for paywalled, blocked, or minimal content articles
 */
function shouldShowReaderButton(
  contentStatus: string | null | undefined,
  contentWordCount: number | null | undefined
): boolean {
  // If we haven't tried fetching yet, show the button
  if (!contentStatus) return true

  // Hide button for known failure states
  if (['paywall', 'blocked', 'timeout', 'error'].includes(contentStatus)) {
    return false
  }

  // Hide button if content is too short (< 100 words)
  // This catches cases like Financial Times where we get minimal HTML
  if (
    contentStatus === 'success' &&
    contentWordCount &&
    contentWordCount < 100
  ) {
    return false
  }

  return true
}

export default function ReadNowButton({
  articleId,
  articleTitle,
  articleUrl,
  disabled = false,
  contentStatus,
  contentWordCount,
}: ReadNowButtonProps) {
  const [isOpen, setIsOpen] = useState(false)

  // Don't render the button if content is unavailable
  if (!shouldShowReaderButton(contentStatus, contentWordCount)) {
    return null
  }

  const handleClick = async () => {
    // Pre-check if the content is available before opening drawer
    try {
      const res = await fetch(`/api/reader/${articleId}`)
      if (!res.ok) {
        // Silently redirect to original site for blocked/paywall/error
        window.open(articleUrl, '_blank', 'noopener,noreferrer')
        return
      }
      // Content available, open reader view
      setIsOpen(true)
    } catch {
      // On error, redirect to original site
      window.open(articleUrl, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={disabled}
        className="text-[11px] sm:text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:text-zinc-400 disabled:cursor-not-allowed transition-colors"
        aria-label="Read article in reader view"
      >
        Read now
      </button>

      <ReaderView
        articleId={articleId}
        articleTitle={articleTitle}
        articleUrl={articleUrl}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </>
  )
}
