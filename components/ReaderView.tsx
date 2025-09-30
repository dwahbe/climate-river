'use client'

import { useState, useEffect } from 'react'
import { Drawer } from 'vaul'
import { X } from 'lucide-react'

type ReaderViewProps = {
  articleId: number
  articleTitle: string
  articleUrl: string
  isOpen: boolean
  onClose: () => void
}

type ReaderData = {
  content: string
  title: string
  author?: string
  wordCount: number
  publishedAt?: string
}

export default function ReaderView({
  articleId,
  articleTitle,
  articleUrl,
  isOpen,
  onClose,
}: ReaderViewProps) {
  const [data, setData] = useState<ReaderData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  // Detect mobile on mount
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Calculate read time (roughly 200 words per minute)
  const readTimeMinutes = data?.wordCount
    ? Math.ceil(data.wordCount / 200)
    : null

  useEffect(() => {
    if (!isOpen || data) return

    const fetchContent = async () => {
      setLoading(true)
      setError(null)

      try {
        const res = await fetch(`/api/reader/${articleId}`)
        const json = await res.json()

        if (!res.ok) {
          if (json.status === 'paywall') {
            setError('This article requires a subscription')
          } else if (json.status === 'blocked') {
            setError('Publisher blocked reader mode')
          } else if (json.status === 'timeout') {
            setError('Article took too long to load')
          } else {
            setError('Could not load article')
          }
          return
        }

        setData(json.data)
      } catch (err) {
        setError('Failed to fetch article')
        console.error('Reader view error:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchContent()
  }, [isOpen, articleId, data])

  const handleClose = () => {
    onClose()
    // Reset state when closing
    setTimeout(() => {
      setData(null)
      setError(null)
    }, 300)
  }

  // Shared content component
  const ReaderContent = () => (
    <>
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900"></div>
        </div>
      )}

      {error && (
        <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-6 text-center">
          <p className="text-zinc-700 mb-3">{error}</p>
          <a
            href={articleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block px-4 py-2 bg-zinc-900 text-white text-sm rounded-md hover:bg-zinc-800 transition"
          >
            Read on original site
          </a>
        </div>
      )}

      {data && !error && (
        <article
          className={`prose prose-zinc max-w-none ${isMobile ? '' : 'prose-lg'}`}
          dangerouslySetInnerHTML={{ __html: data.content }}
        />
      )}
    </>
  )

  return (
    <Drawer.Root
      open={isOpen}
      onOpenChange={handleClose}
      direction={isMobile ? 'bottom' : 'right'}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Drawer.Content
          className={
            isMobile
              ? 'bg-white flex flex-col rounded-t-[10px] h-[90%] mt-24 fixed bottom-0 left-0 right-0 z-50'
              : 'right-2 top-2 bottom-2 fixed z-50 outline-none w-[45%] flex'
          }
          style={
            !isMobile
              ? ({
                  '--initial-transform': 'calc(100% + 8px)',
                } as React.CSSProperties)
              : undefined
          }
        >
          <div
            className={`bg-white h-full w-full flex flex-col ${isMobile ? '' : 'rounded-l-[16px]'}`}
          >
            {/* Mobile drag handle */}
            {isMobile && (
              <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-zinc-300 mt-4 mb-2" />
            )}

            {/* Header */}
            <div
              className={`flex items-start justify-between gap-4 ${isMobile ? 'px-4 pb-4' : 'p-6'} border-b border-zinc-200 bg-zinc-50/50`}
            >
              <div className="flex-1 min-w-0">
                <Drawer.Title className="text-lg font-semibold text-zinc-900 mb-2 line-clamp-2">
                  {data?.title || articleTitle}
                </Drawer.Title>
                <Drawer.Description className="flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                  {data?.author && <span>{data.author}</span>}
                  {data?.author && <span className="text-zinc-400">•</span>}
                  {readTimeMinutes && <span>{readTimeMinutes} min read</span>}
                  {readTimeMinutes && <span className="text-zinc-400">•</span>}
                  <a
                    href={articleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline text-zinc-700 hover:text-zinc-900"
                  >
                    Read on original site →
                  </a>
                </Drawer.Description>
              </div>
              {!isMobile && (
                <button
                  onClick={handleClose}
                  className="flex-shrink-0 p-2 hover:bg-zinc-100 rounded-md transition"
                  aria-label="Close reader view"
                >
                  <X className="w-5 h-5 text-zinc-600" />
                </button>
              )}
            </div>

            {/* Content */}
            <div
              className={`flex-1 overflow-y-auto ${isMobile ? 'px-4 py-6' : 'px-6 py-8'}`}
            >
              <ReaderContent />
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
