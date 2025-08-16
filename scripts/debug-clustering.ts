import { query, endPool } from '@/lib/db'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

async function debugClustering() {
  console.log('🔍 Debugging clustering for specific articles...')

  // Find the two articles we're concerned about
  const articlesResult = await query<{
    id: number
    title: string
    dek: string | null
    embedding: string
    cluster_id: number | null
  }>(
    `SELECT 
       a.id,
       a.title,
       a.dek,
       a.embedding,
       ac.cluster_id
     FROM articles a
     LEFT JOIN article_clusters ac ON a.id = ac.article_id
     WHERE a.title ILIKE '%underground%' 
        OR a.title ILIKE '%parking garage%'
        OR a.title ILIKE '%geothermal%'
     ORDER BY a.id DESC
     LIMIT 10`
  )

  console.log('\n📰 Found articles:')
  for (const article of articlesResult.rows) {
    console.log(`\nID: ${article.id}`)
    console.log(`Title: "${article.title}"`)
    console.log(`Cluster ID: ${article.cluster_id || 'None'}`)
    console.log(`Has Embedding: ${article.embedding ? 'Yes' : 'No'}`)
  }

  // Check if the specific two articles exist
  const specificArticles = await query<{
    id: number
    title: string
    embedding: string
    cluster_id: number | null
  }>(
    `SELECT 
       a.id,
       a.title,
       a.embedding,
       ac.cluster_id
     FROM articles a
     LEFT JOIN article_clusters ac ON a.id = ac.article_id
     WHERE a.title ILIKE '%Subways and Underground Garages%'
        OR a.title ILIKE '%Startup Is Tapping Underground Parking%'
     ORDER BY a.id DESC`
  )

  if (specificArticles.rows.length >= 2) {
    console.log('\n🎯 Found the two specific articles:')
    const article1 = specificArticles.rows[0]
    const article2 = specificArticles.rows[1]

    console.log(`\nArticle 1: "${article1.title}" (ID: ${article1.id})`)
    console.log(`Cluster: ${article1.cluster_id || 'None'}`)

    console.log(`\nArticle 2: "${article2.title}" (ID: ${article2.id})`)
    console.log(`Cluster: ${article2.cluster_id || 'None'}`)

    // Check similarity between these two articles
    if (article1.embedding && article2.embedding) {
      const similarityResult = await query<{ similarity: number }>(
        `SELECT 1 - (a1.embedding <=> a2.embedding) as similarity
         FROM articles a1, articles a2
         WHERE a1.id = $1 AND a2.id = $2`,
        [article1.id, article2.id]
      )

      if (similarityResult.rows.length > 0) {
        const similarity = similarityResult.rows[0].similarity
        console.log(`\n🔍 Semantic Similarity: ${similarity.toFixed(4)}`)
        console.log(`Threshold needed: 0.85`)
        console.log(`Would cluster: ${similarity > 0.85 ? 'YES' : 'NO'}`)
      }
    }

    // Check if they should be in the same cluster
    if (article1.cluster_id && article2.cluster_id) {
      if (article1.cluster_id === article2.cluster_id) {
        console.log('\n✅ Articles are already in the same cluster!')
      } else {
        console.log('\n❌ Articles are in different clusters!')
      }
    } else {
      console.log('\n❌ One or both articles are not clustered!')
    }
  }

  // Check overall clustering stats
  const clusterStats = await query<{
    total_articles: string
    clustered_articles: string
    total_clusters: string
    avg_cluster_size: string
  }>(
    `SELECT 
       COUNT(DISTINCT a.id) as total_articles,
       COUNT(DISTINCT ac.article_id) as clustered_articles,
       COUNT(DISTINCT c.id) as total_clusters,
       ROUND(AVG(cluster_sizes.size), 2) as avg_cluster_size
     FROM articles a
     LEFT JOIN article_clusters ac ON a.id = ac.article_id
     LEFT JOIN clusters c ON ac.cluster_id = c.id
     LEFT JOIN (
       SELECT cluster_id, COUNT(*) as size
       FROM article_clusters
       GROUP BY cluster_id
     ) cluster_sizes ON c.id = cluster_sizes.cluster_id`
  )

  console.log('\n📊 Overall Clustering Statistics:')
  console.log(`Total Articles: ${clusterStats.rows[0].total_articles}`)
  console.log(`Clustered Articles: ${clusterStats.rows[0].clustered_articles}`)
  console.log(`Total Clusters: ${clusterStats.rows[0].total_clusters}`)
  console.log(`Average Cluster Size: ${clusterStats.rows[0].avg_cluster_size}`)

  // Check recent clusters
  const recentClusters = await query<{
    cluster_id: number
    cluster_key: string
    article_count: string
    sample_titles: string[]
  }>(
    `SELECT 
       c.id as cluster_id,
       c.key as cluster_key,
       COUNT(ac.article_id) as article_count,
       ARRAY_AGG(a.title ORDER BY a.id DESC LIMIT 3) as sample_titles
     FROM clusters c
     JOIN article_clusters ac ON c.id = ac.cluster_id
     JOIN articles a ON ac.article_id = a.id
     GROUP BY c.id, c.key
     ORDER BY c.id DESC
     LIMIT 5`
  )

  console.log('\n🔗 Recent Clusters:')
  for (const cluster of recentClusters.rows) {
    console.log(`\nCluster ${cluster.cluster_id} (${cluster.cluster_key}):`)
    console.log(`  Articles: ${cluster.article_count}`)
    console.log(`  Sample titles:`)
    for (const title of cluster.sample_titles) {
      console.log(`    - "${title}"`)
    }
  }
}

// Run the debug
debugClustering()
  .then(() => {
    console.log('\n🔍 Debug complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Debug failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
