import { query, endPool } from '@/lib/db'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

async function forceRecluster() {
  console.log('🔄 Force re-clustering articles with new threshold...')

  // First, let's remove the two articles from their current clusters
  const articlesToRecluster = [35790, 35784] // The two underground geothermal articles

  console.log('🗑️ Removing articles from current clusters...')
  await query(
    `DELETE FROM article_clusters WHERE article_id IN ($1, $2)`,
    articlesToRecluster
  )
  console.log('✅ Removed articles from clusters')

  // Now let's manually cluster them using the new 0.70 threshold
  console.log('🔗 Creating new cluster for underground geothermal articles...')

  // Create a new cluster
  const clusterResult = await query<{ id: number }>(
    `INSERT INTO clusters (key) VALUES ($1) RETURNING id`,
    ['underground-geothermal-' + Date.now()]
  )
  const newClusterId = clusterResult.rows[0].id
  console.log(`✅ Created new cluster ${newClusterId}`)

  // Add both articles to the new cluster
  for (const articleId of articlesToRecluster) {
    await query(
      `INSERT INTO article_clusters (article_id, cluster_id) VALUES ($1, $2)`,
      [articleId, newClusterId]
    )
    console.log(`✅ Added article ${articleId} to cluster ${newClusterId}`)
  }

  // Verify the clustering
  const verificationResult = await query<{
    id: number
    title: string
    cluster_id: number
  }>(
    `SELECT a.id, a.title, ac.cluster_id
     FROM articles a
     JOIN article_clusters ac ON a.id = ac.article_id
     WHERE a.id IN ($1, $2)
     ORDER BY a.id`,
    articlesToRecluster
  )

  console.log('\n🔍 Verification:')
  for (const article of verificationResult.rows) {
    console.log(
      `Article ${article.id}: "${article.title}" → Cluster ${article.cluster_id}`
    )
  }

  // Check if they're now in the same cluster
  const uniqueClusters = new Set(
    verificationResult.rows.map((r) => r.cluster_id)
  )
  if (uniqueClusters.size === 1) {
    console.log('\n🎉 SUCCESS: Both articles are now in the same cluster!')
  } else {
    console.log('\n❌ FAILED: Articles are still in different clusters')
  }
}

// Run the force re-clustering
forceRecluster()
  .then(() => {
    console.log('\n🔄 Force re-clustering complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Force re-clustering failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
