// scripts/prefetch-content.ts
import { query, endPool } from '@/lib/db'
import { prefetchArticles } from '@/lib/services/readerService'

type PrefetchOptions = {
  limit?: number
  closePool?: boolean
  // Optionally prefetch only articles from last N hours
  hoursAgo?: number
}

/**
 * Prefetch article content for recently ingested articles
 * This ensures content is cached before users try to read it
 */
export async function run(opts: PrefetchOptions = {}) {
  const startTime = Date.now()
  const limit = opts.limit ?? 50
  const hoursAgo = opts.hoursAgo ?? 24 // Default: last 24 hours

  console.log(
    `🔄 Prefetching content for up to ${limit} articles from last ${hoursAgo}h...`
  )

  try {
    // Find articles that:
    // 1. Were fetched recently (within hoursAgo)
    // 2. Don't have content yet (content_status is null)
    // 3. Haven't failed multiple times
    const { rows } = await query<{ id: number; title: string }>(
      `
      SELECT id, title
      FROM articles
      WHERE fetched_at >= NOW() - INTERVAL '1 hour' * $1
        AND (content_status IS NULL OR content_status = 'error')
        AND canonical_url NOT LIKE '%nytimes.com%'  -- Skip known paywalls
        AND canonical_url NOT LIKE '%wsj.com%'
        AND canonical_url NOT LIKE '%ft.com%'
        AND canonical_url NOT LIKE '%economist.com%'
        AND canonical_url NOT LIKE '%bloomberg.com%'  -- Often has extraction issues
      ORDER BY published_at DESC NULLS LAST, fetched_at DESC
      LIMIT $2
    `,
      [hoursAgo, limit]
    )

    if (rows.length === 0) {
      console.log('✨ No articles need prefetching')
      if (opts.closePool) await endPool()
      return {
        total: 0,
        duration: Math.round((Date.now() - startTime) / 1000),
      }
    }

    console.log(`📖 Found ${rows.length} articles to prefetch`)

    // Prefetch with concurrency of 3 (balance between speed and politeness)
    await prefetchArticles(
      rows.map((r) => r.id),
      3
    )

    // Check results
    const { rows: results } = await query<{
      content_status: string
      count: number
    }>(
      `
      SELECT 
        COALESCE(content_status, 'pending') as content_status,
        COUNT(*) as count
      FROM articles
      WHERE id = ANY($1)
      GROUP BY content_status
    `,
      [rows.map((r) => r.id)]
    )

    const stats: Record<string, number> = {}
    for (const r of results) {
      stats[r.content_status] = Number(r.count)
    }

    const duration = Math.round((Date.now() - startTime) / 1000)
    console.log(`✅ Prefetch completed in ${duration}s:`, stats)

    if (opts.closePool) await endPool()

    return {
      total: rows.length,
      stats,
      duration,
    }
  } catch (error) {
    console.error('❌ Prefetch failed:', error)
    if (opts.closePool) await endPool()
    throw error
  }
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err)
    endPool().finally(() => process.exit(1))
  })
}
