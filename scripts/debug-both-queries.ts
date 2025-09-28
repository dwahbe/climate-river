import { query, endPool } from '@/lib/db'

async function debugBothQueries() {
  console.log('🔍 Running both queries to compare results...')

  const isLatest = false // Top view
  const topWindowHours = 48
  const limit = 28

  // Query 1: Simple test query
  console.log('\n📊 Query 1: Simple test query...')
  const testQueryResult = await query(
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

  const ourCluster1 = testQueryResult.rows.find((r) => r.cluster_id === 24175)
  console.log(`  Found cluster 24175: ${ourCluster1 ? 'YES' : 'NO'}`)
  if (ourCluster1) {
    console.log(
      `  Position: ${testQueryResult.rows.findIndex((r) => r.cluster_id === 24175) + 1}`
    )
  }

  // Query 2: Full frontend query
  console.log('\n📊 Query 2: Full frontend query...')
  const frontendQueryResult = await query(
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
      l.lead_url,
      l.lead_dek,
      l.lead_author,
      l.lead_source,
      l.lead_homepage,
      l.published_at,
      l.size,
      l.score,

      (SELECT COUNT(DISTINCT s.id)
         FROM article_clusters ac
         JOIN articles a2 ON a2.id = ac.article_id
         LEFT JOIN sources s ON s.id = a2.source_id
        WHERE ac.cluster_id = l.cluster_id)::int AS sources_count,

      (SELECT COUNT(*)
         FROM article_clusters ac
         JOIN articles a2 ON a2.id = ac.article_id
        WHERE ac.cluster_id = l.cluster_id
          AND a2.id <> l.lead_article_id)::int AS subs_total,

      (
        WITH x AS (
          SELECT
            a2.id            AS article_id,
            a2.title,
            a2.canonical_url AS url,
            COALESCE(a2.publisher_name, s2.name) AS source,
            a2.author,
            a2.published_at,

            -- 👇 Hardened host normalization:
            -- 1) extract hostname
            -- 2) lowercase
            -- 3) strip common dupy subdomains (www., m., mobile., amp., amp-cdn., edition., news., beta.)
            COALESCE(
              a2.publisher_host,
              regexp_replace(
                lower(
                  regexp_replace(
                    COALESCE(a2.publisher_homepage, a2.canonical_url),
                    '^https?://([^/]+).*$',
                    '\\1'
                  )
                ),
                '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\.',
                ''
              )
            ) AS host_norm,

            lower(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    COALESCE(a2.rewritten_title, a2.title),
                    '\\s[-—]\\s[^-—]+$',
                    '',
                    'g'
                  ),
                  '[[:punct:]]',
                  ' ',
                  'g'
                ),
                '\\s+',
                ' ',
                'g'
              )
            ) AS title_norm
          FROM article_clusters ac2
          JOIN articles a2 ON a2.id = ac2.article_id
          LEFT JOIN sources s2 ON s2.id = a2.source_id
          WHERE ac2.cluster_id = l.cluster_id
            AND a2.id <> l.lead_article_id
        )
        SELECT COALESCE(json_agg(row_to_json(y)), '[]'::json)
        FROM (
          -- keep one per outlet (host_norm), exclude aggregators and lead article's domain
          SELECT DISTINCT ON (host_norm)
            article_id, title, url, source, author, published_at
          FROM x
          WHERE url NOT LIKE 'https://news.google.com%'
            AND url NOT LIKE 'https://news.yahoo.com%'
            AND url NOT LIKE 'https://news.yahoo.com%'
            AND host_norm NOT IN ('news.google.com', 'news.yahoo.com', 'msn.com')
            AND host_norm <> (
              SELECT COALESCE(
                lead_a.publisher_host,
                regexp_replace(
                  lower(
                    regexp_replace(
                      COALESCE(lead_a.publisher_homepage, lead_a.canonical_url),
                      '^https?://([^/]+).*$',
                      '\\1'
                    )
                  ),
                  '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\.',
                  ''
                )
              )
              FROM articles lead_a 
              WHERE lead_a.id = l.lead_article_id
            )
          ORDER BY
            host_norm,
            published_at DESC
          LIMIT 8
        ) y
      ) AS subs
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

  const ourCluster2 = frontendQueryResult.rows.find(
    (r) => r.cluster_id === 24175
  )
  console.log(`  Found cluster 24175: ${ourCluster2 ? 'YES' : 'NO'}`)
  if (ourCluster2) {
    console.log(
      `  Position: ${frontendQueryResult.rows.findIndex((r) => r.cluster_id === 24175) + 1}`
    )
    console.log(`  Size: ${ourCluster2.size}`)
    console.log(`  Subs Total: ${ourCluster2.subs_total}`)
    console.log(`  Subs Array: ${JSON.stringify(ourCluster2.subs, null, 2)}`)
  }

  // Check if there's a difference in the cluster_scores table
  console.log('\n🔍 Checking cluster_scores table directly...')
  const clusterScoresCheck = await query(
    `SELECT cluster_id, lead_article_id, size, score
     FROM cluster_scores
     WHERE cluster_id = 24175`
  )

  if (clusterScoresCheck.rows.length > 0) {
    const cluster = clusterScoresCheck.rows[0]
    console.log(`  ✅ Cluster 24175 found in cluster_scores:`)
    console.log(`    Lead Article ID: ${cluster.lead_article_id}`)
    console.log(`    Size: ${cluster.size}`)
    console.log(`    Score: ${cluster.score}`)
  } else {
    console.log(`  ❌ Cluster 24175 NOT found in cluster_scores!`)
  }

  // Check if there's a difference in the article_clusters table
  console.log('\n🔍 Checking article_clusters table directly...')
  const articleClustersCheck = await query(
    `SELECT article_id, cluster_id
     FROM article_clusters
     WHERE cluster_id = 24175
     ORDER BY article_id`
  )

  console.log(
    `  Found ${articleClustersCheck.rows.length} articles in cluster 24175:`
  )
  for (const row of articleClustersCheck.rows) {
    console.log(`    Article ${row.article_id} → Cluster ${row.cluster_id}`)
  }
}

// Run the debug
debugBothQueries()
  .then(() => {
    console.log('\n🔍 Both queries debug complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Both queries debug failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
