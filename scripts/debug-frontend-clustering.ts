import { query, endPool } from '@/lib/db'

async function debugFrontendClustering() {
  console.log('🔍 Debugging frontend clustering display...')

  // Check the specific cluster we created
  const clusterId = 24175

  console.log(`\n📊 Checking cluster ${clusterId}:`)

  // Check cluster_scores table
  const clusterScoresResult = await query<{
    cluster_id: number
    lead_article_id: number
    size: number
    score: number
  }>(
    `SELECT cluster_id, lead_article_id, size, score 
     FROM cluster_scores 
     WHERE cluster_id = $1`,
    [clusterId]
  )

  if (clusterScoresResult.rows.length === 0) {
    console.log('❌ No entry in cluster_scores table!')
    console.log("This is why the frontend isn't showing clustering.")

    // Let's check what articles are in this cluster
    const articlesInCluster = await query<{
      id: number
      title: string
    }>(
      `SELECT a.id, a.title
       FROM article_clusters ac
       JOIN articles a ON a.id = ac.article_id
       WHERE ac.cluster_id = $1
       ORDER BY a.id`,
      [clusterId]
    )

    console.log(`\n📰 Articles in cluster ${clusterId}:`)
    for (const article of articlesInCluster.rows) {
      console.log(`  - ${article.id}: "${article.title}"`)
    }

    // Check if we need to create a cluster_scores entry
    if (articlesInCluster.rows.length > 0) {
      console.log('\n🔧 Creating missing cluster_scores entry...')

      const leadArticleId = articlesInCluster.rows[0].id

      await query(
        `INSERT INTO cluster_scores (cluster_id, lead_article_id, size, score)
         VALUES ($1, $2, $3, 1.0)`,
        [clusterId, leadArticleId, articlesInCluster.rows.length]
      )

      console.log('✅ Created cluster_scores entry')
    }
  } else {
    console.log('✅ Found in cluster_scores:')
    const score = clusterScoresResult.rows[0]
    console.log(`  Cluster ID: ${score.cluster_id}`)
    console.log(`  Lead Article ID: ${score.lead_article_id}`)
    console.log(`  Size: ${score.size}`)
    console.log(`  Score: ${score.score}`)
  }

  // Now let's test the exact query the frontend uses
  console.log('\n🔍 Testing frontend query...')

  const frontendQueryResult = await query<{
    cluster_id: number
    lead_article_id: number
    size: number
    subs_total: number
    subs: any[]
  }>(
    `WITH lead AS (
      SELECT
        cs.cluster_id,
        cs.size,
        cs.score,
        a.id AS lead_article_id,
        a.title AS lead_title,
        a.canonical_url AS lead_url,
        a.dek AS lead_dek,
        a.author AS lead_author,
        a.published_at,
        COALESCE(a.publisher_name, s.name) AS lead_source,
        COALESCE(a.publisher_homepage, s.homepage_url) AS lead_homepage
      FROM cluster_scores cs
      JOIN articles a ON a.id = cs.lead_article_id
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE cs.cluster_id = $1
    )
    SELECT
      l.cluster_id,
      l.lead_article_id,
      l.size,
      (SELECT COUNT(*)
         FROM article_clusters ac
         JOIN articles a2 ON a2.id = ac.article_id
        WHERE ac.cluster_id = l.cluster_id
          AND a2.id <> l.lead_article_id)::int AS subs_total,
      (
        SELECT COALESCE(json_agg(row_to_json(y)), '[]'::json)
        FROM (
          SELECT DISTINCT ON (COALESCE(a2.publisher_host, 'unknown'))
            a2.id AS article_id,
            a2.title,
            a2.canonical_url AS url,
            COALESCE(a2.publisher_name, s2.name) AS source,
            a2.author,
            a2.published_at
          FROM article_clusters ac2
          JOIN articles a2 ON a2.id = ac2.article_id
          LEFT JOIN sources s2 ON s2.id = a2.source_id
          WHERE ac2.cluster_id = l.cluster_id
            AND a2.id <> l.lead_article_id
          ORDER BY COALESCE(a2.publisher_host, 'unknown'), a2.published_at DESC
          LIMIT 8
        ) y
      ) AS subs
    FROM lead l`,
    [clusterId]
  )

  if (frontendQueryResult.rows.length > 0) {
    const result = frontendQueryResult.rows[0]
    console.log('\n📊 Frontend query result:')
    console.log(`  Cluster ID: ${result.cluster_id}`)
    console.log(`  Lead Article ID: ${result.lead_article_id}`)
    console.log(`  Size: ${result.size}`)
    console.log(`  Subs Total: ${result.subs_total}`)
    console.log(`  Subs Array: ${JSON.stringify(result.subs, null, 2)}`)

    const isCluster = result.size > 1
    const hasSubs = result.subs && result.subs.length > 0

    console.log(`\n🔍 Frontend logic:`)
    console.log(`  isCluster (size > 1): ${isCluster}`)
    console.log(`  hasSubs (subs.length > 0): ${hasSubs}`)
    console.log(`  Will show "Read more": ${isCluster && hasSubs}`)
  } else {
    console.log('❌ Frontend query returned no results')
  }
}

// Run the debug
debugFrontendClustering()
  .then(() => {
    console.log('\n🔍 Frontend clustering debug complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Frontend clustering debug failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
