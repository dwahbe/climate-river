// lib/services/readerService.ts
import { query } from '@/lib/db'

// Types
export type ReaderSuccess = {
  success: true
  content: string
  title: string
  author?: string
  wordCount: number
  publishedAt?: string
  image?: string
}

export type ReaderError = {
  success: false
  status: 'paywall' | 'timeout' | 'blocked' | 'not_found' | 'error'
  error: string
}

export type ReaderResult = ReaderSuccess | ReaderError

// Paywall detection patterns
const PAYWALL_INDICATORS = [
  /subscribe to read/i,
  /subscription required/i,
  /become a subscriber/i,
  /sign in to continue/i,
  /this article is for subscribers/i,
  /register to continue/i,
  /members only/i,
  /premium content/i,
  /create a free account/i,
]

const BLOCKED_INDICATORS = [
  /access denied/i,
  /403 forbidden/i,
  /cloudflare/i,
  /unusual traffic/i,
]

/**
 * Detect if content appears to be a paywall message
 */
function detectPaywall(html: string, text: string, wordCount: number): boolean {
  // Very short content is suspicious
  if (wordCount < 100) {
    return PAYWALL_INDICATORS.some((pattern) => text.match(pattern))
  }

  // Check for paywall indicators in first 500 chars
  const preview = text.slice(0, 500)
  return PAYWALL_INDICATORS.some((pattern) => preview.match(pattern))
}

/**
 * Detect if we've been blocked by anti-bot measures
 */
function detectBlocked(html: string, text: string): boolean {
  return BLOCKED_INDICATORS.some((pattern) => text.match(pattern))
}

/**
 * Fetch article content using Defuddle
 * Uses dynamic imports to reduce cold start time
 */
async function fetchArticleContent(url: string): Promise<ReaderResult> {
  const startTime = Date.now()
  const TIMEOUT = 8000 // 8 seconds (leaving 2s buffer for Vercel's 10s limit)

  try {
    // Dynamic imports to reduce cold start
    const [{ JSDOM }, { Defuddle }] = await Promise.all([
      import('jsdom'),
      import('defuddle/node'),
    ])

    // Race between fetch and timeout
    const fetchPromise = (async () => {
      // Fetch with proper headers
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ClimateRiverBot/1.0 (+https://climateriver.org)',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
      })

      if (!response.ok) {
        if (response.status === 404) {
          return {
            success: false,
            status: 'not_found',
            error: 'Article not found',
          } as ReaderError
        }
        if (response.status === 403) {
          return {
            success: false,
            status: 'blocked',
            error: 'Access denied by publisher',
          } as ReaderError
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const html = await response.text()

      // Parse with JSDOM
      const dom = new JSDOM(html, { url })

      // Use Defuddle to extract clean content
      const result = await Defuddle(dom, url, {
        debug: false,
        markdown: false, // We'll store HTML
      })

      // Cleanup JSDOM to free memory
      dom.window.close()

      // Aggressive cleanup: Defuddle sometimes includes too much page scaffolding
      if (result.content) {
        // Use regex-based cleaning to avoid JSDOM CSS parsing errors
        let cleaned = result.content

        // Remove tags entirely
        cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        cleaned = cleaned.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
        cleaned = cleaned.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
        cleaned = cleaned.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        cleaned = cleaned.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        cleaned = cleaned.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
        cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '')

        // Strip all class, id, style, and data-* attributes
        cleaned = cleaned.replace(/\s+class="[^"]*"/gi, '')
        cleaned = cleaned.replace(/\s+id="[^"]*"/gi, '')
        cleaned = cleaned.replace(/\s+style="[^"]*"/gi, '')
        cleaned = cleaned.replace(/\s+data-[a-z-]+=["'][^"']*["']/gi, '')

        result.content = cleaned.trim()
      }

      // Detect paywall or blocking
      if (detectBlocked(result.content || '', result.content || '')) {
        return {
          success: false,
          status: 'blocked',
          error: 'Publisher blocked automated access',
        } as ReaderError
      }

      if (
        detectPaywall(
          result.content || '',
          result.content || '',
          result.wordCount || 0
        )
      ) {
        return {
          success: false,
          status: 'paywall',
          error: 'Article requires subscription',
        } as ReaderError
      }

      // Success!
      return {
        success: true,
        content: result.content || '',
        title: result.title || '',
        author: result.author,
        wordCount: result.wordCount || 0,
        publishedAt: result.published,
        image: result.image,
      } as ReaderSuccess
    })()

    const timeoutPromise = new Promise<ReaderError>((resolve) =>
      setTimeout(() => {
        resolve({
          success: false,
          status: 'timeout',
          error: `Request timed out after ${TIMEOUT}ms`,
        })
      }, TIMEOUT)
    )

    const result = await Promise.race([fetchPromise, timeoutPromise])

    const elapsed = Date.now() - startTime
    console.log(
      `📖 Fetched ${url} in ${elapsed}ms - ${result.success ? 'SUCCESS' : result.status}`
    )

    return result
  } catch (error: any) {
    console.error('❌ Reader fetch error:', error)
    return {
      success: false,
      status: 'error',
      error: error.message || 'Failed to fetch article',
    }
  }
}

/**
 * Get article content from cache or fetch if needed
 */
export async function getArticleContent(
  articleId: number
): Promise<ReaderResult & { fromCache: boolean }> {
  // Check cache first
  const cached = await query<{
    content_html: string | null
    content_text: string | null
    content_word_count: number | null
    content_status: string | null
    content_error: string | null
    content_fetched_at: Date | null
    canonical_url: string
    title: string
    author: string | null
    published_at: Date | null
  }>(
    `
    SELECT 
      content_html,
      content_text,
      content_word_count,
      content_status,
      content_error,
      content_fetched_at,
      canonical_url,
      title,
      author,
      published_at
    FROM articles
    WHERE id = $1
  `,
    [articleId]
  )

  if (cached.rows.length === 0) {
    return {
      success: false,
      status: 'not_found',
      error: 'Article not found in database',
      fromCache: false,
    }
  }

  const article = cached.rows[0]

  // Return from cache if we have it (within 7 days)
  const cacheAge = article.content_fetched_at
    ? Date.now() - article.content_fetched_at.getTime()
    : Infinity
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

  if (article.content_status && cacheAge < CACHE_TTL) {
    if (article.content_status === 'success' && article.content_html) {
      return {
        success: true,
        content: article.content_html,
        title: article.title,
        author: article.author || undefined,
        wordCount: article.content_word_count || 0,
        publishedAt: article.published_at?.toISOString(),
        fromCache: true,
      }
    } else {
      // Cached error state
      return {
        success: false,
        status: article.content_status as any,
        error: article.content_error || 'Previously failed to fetch',
        fromCache: true,
      }
    }
  }

  // Cache miss or expired - fetch fresh content
  console.log(`🔄 Cache miss/expired for article ${articleId}, fetching...`)
  const result = await fetchArticleContent(article.canonical_url)

  // Store result in database
  if (result.success) {
    await query(
      `
      UPDATE articles
      SET 
        content_html = $1,
        content_text = $2,
        content_word_count = $3,
        content_status = 'success',
        content_error = NULL,
        content_fetched_at = NOW()
      WHERE id = $4
    `,
      [
        result.content,
        result.content, // TODO: strip HTML for content_text
        result.wordCount,
        articleId,
      ]
    )
  } else {
    await query(
      `
      UPDATE articles
      SET 
        content_status = $1,
        content_error = $2,
        content_fetched_at = NOW()
      WHERE id = $3
    `,
      [result.status, result.error, articleId]
    )
  }

  return { ...result, fromCache: false }
}

/**
 * Prefetch content for multiple articles (for background jobs)
 */
export async function prefetchArticles(
  articleIds: number[],
  concurrency = 2
): Promise<void> {
  console.log(
    `🔄 Prefetching ${articleIds.length} articles with concurrency ${concurrency}`
  )

  const queue = [...articleIds]
  const active: Promise<any>[] = []

  while (queue.length > 0 || active.length > 0) {
    // Fill up to concurrency limit
    while (active.length < concurrency && queue.length > 0) {
      const id = queue.shift()!
      const promise = getArticleContent(id)
        .then(() => {
          const idx = active.indexOf(promise)
          if (idx > -1) active.splice(idx, 1)
        })
        .catch((err) => {
          console.error(`Failed to prefetch article ${id}:`, err)
          const idx = active.indexOf(promise)
          if (idx > -1) active.splice(idx, 1)
        })
      active.push(promise)
    }

    // Wait for at least one to complete
    if (active.length > 0) {
      await Promise.race(active)
    }
  }

  console.log(`✅ Prefetch complete`)
}
