import { query, endPool } from '@/lib/db'

async function testHomepageQuery() {
  console.log('🔍 Testing exact homepage query...')

  const isLatest = false // Top view
  const topWindowHours = 48
  const limit = 28

  console.log(`\n📊 Query parameters:`)
  console.log(`  isLatest: ${isLatest}`)
  console.log(`  topWindowHours: ${topWindowHours}`)
  console.log(`  limit: ${limit}`)

  // Test the exact query from the homepage
  const { rows } = await query(
    `
    WITH lead AS (
      SELECT
        cs.cluster_id,
        cs.size,
        cs.score,
        a.id AS lead_article_id,
        COALESCE(a.rewritten_title, a.title) AS lead_title,
        a.canonical_url  AS lead_url,
        a.dek            AS lead_dek,
        a.author         AS lead_author,
        a.published_at,
        COALESCE(a.publisher_name, s.name)              AS lead_source,
        COALESCE(a.publisher_homepage, s.homepage_url)  AS lead_homepage
      FROM cluster_scores cs
      JOIN articles a ON a.id = cs.lead_article_id
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE ($1::boolean
         OR a.published_at >= now() - make_interval(hours => $2::int))
        AND a.canonical_url NOT LIKE 'https://news.google.com%'
        AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
        AND a.canonical_url NOT LIKE 'https://www.msn.com%'
    )
    SELECT
      l.cluster_id,
      l.lead_article_id,
      l.lead_title,
      l.size,
      l.score,
      l.published_at
    FROM lead l
    ORDER BY
      CASE WHEN $1::boolean THEN l.published_at END DESC NULLS LAST, -- Latest
      CASE WHEN NOT $1::boolean THEN l.score END DESC NULLS LAST,     -- Top
      CASE WHEN NOT $1::boolean THEN (l.cluster_id % 13) END DESC,    -- stable jitter
      l.cluster_id DESC
    LIMIT $3::int
  `,
    [isLatest, topWindowHours, limit]
  )

  console.log(`\n📰 Found ${rows.length} clusters in homepage query:`)

  // Look for our specific cluster
  const ourCluster = rows.find((r) => r.cluster_id === 24175)

  if (ourCluster) {
    console.log(`\n🎯 Found our cluster 24175:`)
    console.log(`  Lead Article ID: ${ourCluster.lead_article_id}`)
    console.log(`  Title: "${ourCluster.lead_title}"`)
    console.log(`  Size: ${ourCluster.size}`)
    console.log(`  Score: ${ourCluster.score}`)
    console.log(`  Published: ${ourCluster.published_at}`)
  } else {
    console.log(`\n❌ Our cluster 24175 NOT found in homepage results!`)

    // Check if it's being filtered by the time window
    console.log(`\n🔍 Checking time window filter...`)

    const timeCheck = await query(
      `SELECT 
         a.id,
         a.title,
         a.published_at,
         a.published_at >= now() - make_interval(hours => $1::int) as within_window,
         now() - make_interval(hours => $1::int) as cutoff_time
       FROM articles a
       WHERE a.id IN (35784, 35790)`,
      [topWindowHours]
    )

    for (const row of timeCheck.rows) {
      console.log(`\nArticle ${row.id}: "${row.title}"`)
      console.log(`  Published: ${row.published_at}`)
      console.log(`  Cutoff time: ${row.cutoff_time}`)
      console.log(`  Within 48h window: ${row.within_window}`)
    }
  }

  // Show first few results
  console.log(`\n📋 First 5 clusters from homepage:`)
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i]
    console.log(
      `  ${i + 1}. Cluster ${row.cluster_id}: "${row.lead_title}" (size: ${row.size})`
    )
  }
}

// Run the test
testHomepageQuery()
  .then(() => {
    console.log('\n🔍 Homepage query test complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Homepage query test failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
