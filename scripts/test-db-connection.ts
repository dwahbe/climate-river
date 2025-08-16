import { query, endPool } from '@/lib/db'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

async function testDbConnection() {
  console.log('🔍 Testing database connection...')

  try {
    // Simple query to test connection
    const result = await query('SELECT NOW() as current_time')
    console.log('✅ Database connection successful')
    console.log(`  Current time: ${result.rows[0].current_time}`)

    // Test cluster_scores table
    const clusterResult = await query(
      'SELECT COUNT(*) as count FROM cluster_scores'
    )
    console.log(
      `  Total clusters in cluster_scores: ${clusterResult.rows[0].count}`
    )

    // Test our specific cluster
    const ourClusterResult = await query(
      'SELECT cluster_id, size, score FROM cluster_scores WHERE cluster_id = 24175'
    )

    if (ourClusterResult.rows.length > 0) {
      const cluster = ourClusterResult.rows[0]
      console.log(`  ✅ Our cluster 24175 found:`)
      console.log(`    Size: ${cluster.size}`)
      console.log(`    Score: ${cluster.score}`)
    } else {
      console.log(`  ❌ Our cluster 24175 NOT found in cluster_scores`)
    }

    // Test the homepage query
    console.log('\n🔍 Testing homepage query...')
    const homepageResult = await query(
      `SELECT cluster_id, size, score 
       FROM cluster_scores 
       ORDER BY score DESC 
       LIMIT 5`
    )

    console.log('  Top 5 clusters by score:')
    for (let i = 0; i < homepageResult.rows.length; i++) {
      const row = homepageResult.rows[i]
      console.log(
        `    ${i + 1}. Cluster ${row.cluster_id}: Score ${row.score}, Size ${row.size}`
      )
    }

    // Check if our cluster is in the top results
    const ourClusterInTop = homepageResult.rows.find(
      (r) => r.cluster_id === 24175
    )
    if (ourClusterInTop) {
      console.log(
        `  🎯 Our cluster 24175 found in top results at position ${homepageResult.rows.findIndex((r) => r.cluster_id === 24175) + 1}`
      )
    } else {
      console.log(`  ❌ Our cluster 24175 NOT in top 5 results`)
    }
  } catch (error) {
    console.error('❌ Database connection failed:', error)
  }
}

// Run the test
testDbConnection()
  .then(() => {
    console.log('\n🔍 Database connection test complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Database connection test failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
