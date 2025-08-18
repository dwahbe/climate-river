// scripts/backfill-categories.ts
// Backfill categories for existing articles using hybrid classification

import * as DB from '../lib/db'
import { categorizeAndStoreArticle } from '../lib/categorizer'

interface Article {
  id: number
  title: string
  dek: string | null
  published_at: string
}

async function backfillCategories() {
  console.log('🏷️  Starting category backfill...')

  try {
    // Get all articles that don't have categories yet
    const { rows: articles } = await DB.query<Article>(`
      SELECT DISTINCT a.id, a.title, a.dek, a.published_at
      FROM articles a
      LEFT JOIN article_categories ac ON ac.article_id = a.id
      WHERE ac.article_id IS NULL
        AND a.published_at >= NOW() - INTERVAL '30 days'  -- Only recent articles
      ORDER BY a.published_at DESC
      LIMIT 500  -- Process in batches for safety
    `)

    console.log(`📊 Found ${articles.length} articles to categorize`)

    if (articles.length === 0) {
      console.log('✅ No articles need categorization')
      return
    }

    let processed = 0
    let succeeded = 0
    let failed = 0

    // Process articles in smaller batches to avoid rate limits
    const batchSize = 10

    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize)

      console.log(
        `\n🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(articles.length / batchSize)}...`
      )

      // Process batch sequentially to avoid overwhelming OpenAI API
      for (const article of batch) {
        try {
          console.log(`  📝 Categorizing: "${article.title.slice(0, 60)}..."`)

          await categorizeAndStoreArticle(
            article.id,
            article.title,
            article.dek || undefined
          )

          succeeded++
          console.log(`  ✅ Success (${succeeded}/${articles.length})`)
        } catch (error) {
          failed++
          console.error(`  ❌ Failed for article ${article.id}:`, error)
        }

        processed++

        // Small delay to be respectful to OpenAI API
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      // Longer delay between batches
      if (i + batchSize < articles.length) {
        console.log(`   ⏸️  Waiting 2s before next batch...`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    console.log(`\n📈 Backfill complete!`)
    console.log(`   ✅ Succeeded: ${succeeded}`)
    console.log(`   ❌ Failed: ${failed}`)
    console.log(`   📊 Total processed: ${processed}`)

    // Show category distribution
    console.log(`\n📊 Category distribution:`)
    const { rows: stats } = await DB.query(`
      SELECT 
        c.name,
        COUNT(ac.article_id) as count,
        ROUND(AVG(ac.confidence)::numeric, 3) as avg_confidence
      FROM categories c
      LEFT JOIN article_categories ac ON ac.category_id = c.id
      GROUP BY c.id, c.name
      ORDER BY count DESC
    `)

    stats.forEach((stat) => {
      console.log(
        `   ${stat.name}: ${stat.count} articles (avg confidence: ${stat.avg_confidence || 0})`
      )
    })
  } catch (error) {
    console.error('💥 Fatal error during backfill:', error)
    throw error
  }
}

async function main() {
  try {
    await backfillCategories()
  } catch (error) {
    console.error('Script failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    // Clean up database connections
    await DB.endPool()
  }
}

// Run if called directly
main().catch(console.error)
