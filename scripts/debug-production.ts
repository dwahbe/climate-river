#!/usr/bin/env tsx
import { query } from '../lib/db.js'

async function debugProduction() {
  try {
    console.log('🔍 Debugging production issue...\n')

    // Check cluster_scores count
    const clusterScoresResult = await query(
      'SELECT COUNT(*) as count FROM cluster_scores'
    )
    console.log(`📈 Cluster scores: ${clusterScoresResult.rows[0].count}`)

    // Check article time distribution
    console.log('\n🕰️ Articles by time window:')
    const timeWindows = [24, 48, 72, 168] // 1 day, 2 days, 3 days, 1 week

    for (const hours of timeWindows) {
      const result = await query(`
        SELECT COUNT(*) as count
        FROM cluster_scores cs
        JOIN articles a ON a.id = cs.lead_article_id
        WHERE a.published_at >= now() - make_interval(hours => ${hours})
          AND a.canonical_url NOT LIKE 'https://news.google.com%'
          AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
          AND a.canonical_url NOT LIKE 'https://www.msn.com%'
      `)
      console.log(`  ${hours} hours: ${result.rows[0].count} articles`)
    }

    // Check most recent articles
    console.log('\n📰 10 Most recent articles:')
    const recent = await query(`
      SELECT a.title, a.published_at, cs.score
      FROM cluster_scores cs
      JOIN articles a ON a.id = cs.lead_article_id
      WHERE a.canonical_url NOT LIKE 'https://news.google.com%'
        AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
        AND a.canonical_url NOT LIKE 'https://www.msn.com%'
      ORDER BY a.published_at DESC
      LIMIT 10
    `)

    recent.rows.forEach((row, i) => {
      const hoursAgo = Math.round(
        (Date.now() - new Date(row.published_at).getTime()) / (1000 * 60 * 60)
      )
      console.log(
        `  ${i + 1}. ${row.title.slice(0, 60)}... (${hoursAgo}h ago, score: ${row.score})`
      )
    })
  } catch (error) {
    console.error('❌ Error:', error.message)
  }

  process.exit(0)
}

debugProduction()
