import { query, endPool } from '@/lib/db'

async function checkClusterScores() {
  console.log('🔍 Checking cluster_scores table for conflicting entries...')

  // Check for our specific articles
  const articlesToCheck = [35784, 35790]

  console.log(`\n📰 Checking articles: ${articlesToCheck.join(', ')}`)

  // Check what's in cluster_scores for these articles
  const clusterScoresResult = await query<{
    cluster_id: number
    lead_article_id: number
    size: number
    score: number
  }>(
    `SELECT cs.cluster_id, cs.lead_article_id, cs.size, cs.score
     FROM cluster_scores cs
     WHERE cs.lead_article_id IN ($1, $2)
     ORDER BY cs.cluster_id`,
    articlesToCheck
  )

  console.log(
    `\n📊 Found ${clusterScoresResult.rows.length} entries in cluster_scores:`
  )
  for (const row of clusterScoresResult.rows) {
    console.log(
      `  Cluster ${row.cluster_id}: Lead article ${row.lead_article_id}, Size ${row.size}, Score ${row.score}`
    )
  }

  // Check what's in article_clusters for these articles
  const articleClustersResult = await query<{
    article_id: number
    cluster_id: number
  }>(
    `SELECT ac.article_id, ac.cluster_id
     FROM article_clusters ac
     WHERE ac.article_id IN ($1, $2)
     ORDER BY ac.article_id`,
    articlesToCheck
  )

  console.log(
    `\n🔗 Found ${articleClustersResult.rows.length} entries in article_clusters:`
  )
  for (const row of articleClustersResult.rows) {
    console.log(`  Article ${row.article_id} → Cluster ${row.cluster_id}`)
  }

  // Check if there are multiple cluster_scores entries for the same cluster
  const duplicateClustersResult = await query<{
    cluster_id: number
    count: string
  }>(
    `SELECT cluster_id, COUNT(*) as count
     FROM cluster_scores
     GROUP BY cluster_id
     HAVING COUNT(*) > 1
     ORDER BY cluster_id`
  )

  if (duplicateClustersResult.rows.length > 0) {
    console.log(`\n⚠️ Found clusters with multiple entries in cluster_scores:`)
    for (const row of duplicateClustersResult.rows) {
      console.log(`  Cluster ${row.cluster_id}: ${row.count} entries`)
    }
  } else {
    console.log(`\n✅ No duplicate cluster entries found`)
  }

  // Check if there are orphaned cluster_scores entries
  const orphanedResult = await query<{
    cluster_id: number
    lead_article_id: number
  }>(
    `SELECT cs.cluster_id, cs.lead_article_id
     FROM cluster_scores cs
     LEFT JOIN article_clusters ac ON cs.cluster_id = ac.cluster_id
     WHERE ac.cluster_id IS NULL`
  )

  if (orphanedResult.rows.length > 0) {
    console.log(`\n⚠️ Found orphaned cluster_scores entries (no articles):`)
    for (const row of orphanedResult.rows) {
      console.log(
        `  Cluster ${row.cluster_id}: Lead article ${row.lead_article_id}`
      )
    }
  } else {
    console.log(`\n✅ No orphaned cluster_scores entries found`)
  }
}

// Run the check
checkClusterScores()
  .then(() => {
    console.log('\n🔍 Cluster scores check complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Cluster scores check failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
