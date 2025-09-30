// scripts/categorize.ts
import { query, endPool } from '@/lib/db'
import { categorizeAndStoreArticle } from '@/lib/categorizer'

export async function run(opts: { limit?: number; closePool?: boolean } = {}) {
  const start = Date.now()
  console.log('🏷️  Starting bulk categorization...')

  // Get all articles that need categorization
  // Either articles with no categories, or all articles if limit is specified
  const limit = opts.limit || 1000 // Default to 1000 articles

  const { rows } = await query<{
    id: number
    title: string
    dek: string | null
  }>(
    `
    SELECT a.id, a.title, a.dek
    FROM articles a
    LEFT JOIN article_categories ac ON ac.article_id = a.id
    WHERE ac.article_id IS NULL
      AND a.published_at >= now() - interval '30 days'
    ORDER BY a.published_at DESC
    LIMIT $1
  `,
    [limit]
  )

  console.log(`📊 Found ${rows.length} articles to categorize`)

  let processed = 0
  let succeeded = 0
  let failed = 0

  for (const article of rows) {
    processed++

    try {
      await categorizeAndStoreArticle(
        article.id,
        article.title,
        article.dek || undefined
      )
      succeeded++

      if (processed % 10 === 0) {
        console.log(
          `  ⏳ Progress: ${processed}/${rows.length} (${succeeded} succeeded, ${failed} failed)`
        )
      }
    } catch (error) {
      failed++
      console.error(
        `  ❌ Failed to categorize article ${article.id}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const elapsed = Date.now() - start
  console.log(`\n✅ Bulk categorization complete!`)
  console.log(`📈 Results:`)
  console.log(`   - Processed: ${processed}`)
  console.log(`   - Succeeded: ${succeeded}`)
  console.log(`   - Failed: ${failed}`)
  console.log(`   - Time: ${(elapsed / 1000).toFixed(1)}s`)

  if (opts.closePool) await endPool()
  return { ok: true, processed, succeeded, failed }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err)
    endPool().finally(() => process.exit(1))
  })
}
