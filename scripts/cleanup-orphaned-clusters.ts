import { query, endPool } from '@/lib/db'

async function cleanupOrphanedClusters() {
  console.log('🧹 Cleaning up orphaned cluster entries...')

  // Find orphaned cluster_scores entries (no articles in article_clusters)
  const orphanedResult = await query<{
    cluster_id: number
    lead_article_id: number
  }>(
    `SELECT cs.cluster_id, cs.lead_article_id
     FROM cluster_scores cs
     LEFT JOIN article_clusters ac ON cs.cluster_id = ac.cluster_id
     WHERE ac.cluster_id IS NULL`
  )

  if (orphanedResult.rows.length === 0) {
    console.log('✅ No orphaned clusters found')
    return
  }

  console.log(`\n📊 Found ${orphanedResult.rows.length} orphaned clusters:`)
  for (const row of orphanedResult.rows) {
    console.log(
      `  Cluster ${row.cluster_id}: Lead article ${row.lead_article_id}`
    )
  }

  // Delete orphaned cluster_scores entries
  console.log('\n🗑️ Deleting orphaned cluster_scores entries...')

  const deleteResult = await query(
    `DELETE FROM cluster_scores cs
     WHERE NOT EXISTS (
       SELECT 1 FROM article_clusters ac WHERE ac.cluster_id = cs.cluster_id
     )`
  )

  console.log(
    `✅ Deleted ${deleteResult.rowCount} orphaned cluster_scores entries`
  )

  // Also delete orphaned clusters entries
  console.log('\n🗑️ Deleting orphaned clusters entries...')

  const deleteClustersResult = await query(
    `DELETE FROM clusters c
     WHERE NOT EXISTS (
       SELECT 1 FROM article_clusters ac WHERE ac.cluster_id = c.id
     )`
  )

  console.log(
    `✅ Deleted ${deleteClustersResult.rowCount} orphaned clusters entries`
  )

  // Verify cleanup
  console.log('\n🔍 Verifying cleanup...')

  const remainingOrphaned = await query(
    `SELECT COUNT(*) as count
     FROM cluster_scores cs
     LEFT JOIN article_clusters ac ON cs.cluster_id = ac.cluster_id
     WHERE ac.cluster_id IS NULL`
  )

  if (parseInt(remainingOrphaned.rows[0].count) === 0) {
    console.log('✅ All orphaned clusters cleaned up successfully!')
  } else {
    console.log(
      `⚠️ Still have ${remainingOrphaned.rows[0].count} orphaned clusters`
    )
  }

  // Check our target cluster
  console.log('\n🎯 Checking our target cluster 24175...')

  const targetClusterResult = await query<{
    cluster_id: number
    lead_article_id: number
    size: number
    score: number
  }>(
    `SELECT cs.cluster_id, cs.lead_article_id, cs.size, cs.score
     FROM cluster_scores cs
     WHERE cs.cluster_id = 24175`
  )

  if (targetClusterResult.rows.length > 0) {
    const cluster = targetClusterResult.rows[0]
    console.log(`✅ Cluster 24175 found:`)
    console.log(`  Lead Article ID: ${cluster.lead_article_id}`)
    console.log(`  Size: ${cluster.size}`)
    console.log(`  Score: ${cluster.score}`)
  } else {
    console.log('❌ Cluster 24175 not found in cluster_scores')
  }
}

// Run the cleanup
cleanupOrphanedClusters()
  .then(() => {
    console.log('\n🧹 Cleanup complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Cleanup failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
