#!/usr/bin/env tsx
import { query } from '../lib/db.js'

async function checkCategories() {
  try {
    console.log('🔍 Checking categorization status...\n')

    // Check total articles
    const articlesResult = await query('SELECT COUNT(*) as total FROM articles')
    console.log(`📰 Total Articles: ${articlesResult.rows[0].total}`)

    // Check categorized articles
    const categorizedResult = await query(
      'SELECT COUNT(*) as total FROM article_categories'
    )
    console.log(`📝 Categorized Articles: ${categorizedResult.rows[0].total}`)

    // Check category breakdown
    const categoryResult = await query(`
      SELECT c.slug, c.name, COUNT(ac.article_id) as count 
      FROM categories c 
      LEFT JOIN article_categories ac ON c.id = ac.category_id 
      GROUP BY c.id, c.slug, c.name 
      ORDER BY count DESC
    `)

    console.log('\n📊 Category Breakdown:')
    categoryResult.rows.forEach((row) => {
      console.log(`  ${row.slug}: ${row.count} articles`)
    })

    // Check recent articles without categories
    const recentUncategorized = await query(`
      SELECT COUNT(*) as count 
      FROM articles a 
      LEFT JOIN article_categories ac ON a.id = ac.article_id 
      WHERE ac.article_id IS NULL 
      AND a.fetched_at > NOW() - INTERVAL '7 days'
    `)

    console.log(
      `\n❓ Recent uncategorized articles (last 7 days): ${recentUncategorized.rows[0].count}`
    )
  } catch (error) {
    console.error('❌ Error:', error.message)
  }

  process.exit(0)
}

checkCategories()
