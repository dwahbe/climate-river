'use client'

import { useState } from 'react'
import ReaderView from './ReaderView'

type ReadNowButtonProps = {
  articleId: number
  articleTitle: string
  articleUrl: string
  disabled?: boolean
}

export default function ReadNowButton({
  articleId,
  articleTitle,
  articleUrl,
  disabled = false,
}: ReadNowButtonProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
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
