// scripts/cleanup-non-climate.ts
// Remove categories from non-climate articles so they disappear from the river

import { query, endPool } from '@/lib/db'
import { isClimateRelevant } from '@/lib/tagger'

export async function run(opts: { dryRun?: boolean; closePool?: boolean } = {}) {
  const start = Date.now()
  const dryRun = opts.dryRun ?? false

  console.log('🧹 Starting cleanup of non-climate articles...')
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - no changes will be made\n')
  }

  const { rows } = await query<{
    id: number
    title: string
    dek: string | null
    category_count: number
  }>(
    `
    SELECT 
      a.id, 
      a.title, 
      a.dek,
      COUNT(ac.category_id)::int as category_count
    FROM articles a
    INNER JOIN article_categories ac ON ac.article_id = a.id
    WHERE a.published_at >= now() - interval '30 days'
    GROUP BY a.id, a.title, a.dek
    ORDER BY a.published_at DESC
  `
  )

  console.log(`📊 Found ${rows.length} categorized articles to check\n`)

  let checked = 0
  let filtered = 0
  let kept = 0
  const filteredArticles: Array<{ id: number; title: string }> = []

  for (const article of rows) {
    checked++

    const isRelevant = isClimateRelevant({
      title: article.title,
      summary: article.dek,
    })

    if (!isRelevant) {
      filtered++
      filteredArticles.push({ id: article.id, title: article.title })

      console.log(`❌ Non-climate: "${article.title.substring(0, 80)}..."`)
      console.log(`   Categories: ${article.category_count}`)

      if (!dryRun) {
        await query('DELETE FROM article_categories WHERE article_id = $1', [
          article.id,
        ])
        console.log(`   ✓ Removed categories\n`)
      } else {
        console.log(`   (would remove ${article.category_count} categories)\n`)
      }
    } else {
      kept++
      if (checked % 100 === 0) {
        console.log(
          `⏳ Progress: ${checked}/${rows.length} (${kept} kept, ${filtered} filtered)`
        )
      }
    }
  }

  const elapsed = Date.now() - start

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Cleanup complete!`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📈 Results:`)
  console.log(`   - Total checked: ${checked}`)
  console.log(`   - Climate-relevant (kept): ${kept}`)
  console.log(`   - Non-climate (filtered): ${filtered}`)
  console.log(`   - Time: ${(elapsed / 1000).toFixed(1)}s`)

  if (filteredArticles.length > 0) {
    console.log(`\n🗑️  Filtered articles:`)
    filteredArticles.slice(0, 10).forEach((a, i) => {
      console.log(`   ${i + 1}. "${a.title.substring(0, 70)}..."`)
    })

    if (filteredArticles.length > 10) {
      console.log(`   ... and ${filteredArticles.length - 10} more`)
    }
  }

  if (dryRun) {
    console.log(`\n💡 This was a DRY RUN. Run without --dry-run to apply changes.`)
  } else {
    console.log(`\n✨ ${filtered} non-climate articles removed from river!`)
  }

  if (opts.closePool) await endPool()

  return { ok: true, checked, kept, filtered, filteredArticles }
}

// CLI with dry-run support
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d')

  if (dryRun) {
    console.log('Running in DRY RUN mode (no changes will be made)')
    console.log('Remove --dry-run flag to apply changes\n')
  }

  run({ closePool: true, dryRun }).catch((err) => {
    console.error('❌ Cleanup failed:', err)
    endPool().finally(() => process.exit(1))
  })
}



