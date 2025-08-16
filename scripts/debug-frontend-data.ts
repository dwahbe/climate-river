import { query, endPool } from '@/lib/db'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

async function debugFrontendData() {
  console.log('🔍 Debugging frontend data for our cluster...')

  const isLatest = false // Top view
  const topWindowHours = 48
  const limit = 28

  // Run the EXACT query from the frontend
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
            AND url NOT LIKE 'https://www.msn.com%'
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

  // Find our cluster
  const ourCluster = rows.find((r) => r.cluster_id === 24175)

  if (!ourCluster) {
    console.log('❌ Our cluster 24175 not found in frontend results!')
    return
  }

  console.log('\n🎯 Found our cluster 24175 in frontend data:')
  console.log(`  Lead Article ID: ${ourCluster.lead_article_id}`)
  console.log(`  Title: "${ourCluster.lead_title}"`)
  console.log(`  Size: ${ourCluster.size}`)
  console.log(`  Score: ${ourCluster.score}`)
  console.log(`  Sources Count: ${ourCluster.sources_count}`)
  console.log(`  Subs Total: ${ourCluster.subs_total}`)
  console.log(`  Subs Array: ${JSON.stringify(ourCluster.subs, null, 2)}`)

  // Frontend logic
  const secondaries = ourCluster.subs ?? []
  const isCluster = ourCluster.size > 1
  const hasSubs = secondaries.length > 0

  console.log('\n🔍 Frontend logic breakdown:')
  console.log(`  isCluster (size > 1): ${isCluster} (${ourCluster.size} > 1)`)
  console.log(
    `  hasSubs (subs.length > 0): ${hasSubs} (${secondaries.length} > 0)`
  )
  console.log(`  Will show "Read more": ${isCluster && hasSubs}`)

  if (secondaries.length === 0) {
    console.log('\n🔍 Why is subs array empty? Let me check the subs query...')

    // Check what articles are in our cluster
    const clusterArticles = await query<{
      id: number
      title: string
      canonical_url: string
      publisher_homepage: string | null
      publisher_host: string | null
    }>(
      `SELECT 
         a.id,
         a.title,
         a.canonical_url,
         a.publisher_homepage,
         a.publisher_host
       FROM article_clusters ac
       JOIN articles a ON a.id = ac.article_id
       WHERE ac.cluster_id = 24175
       ORDER BY a.id`
    )

    console.log('\n📰 Articles in cluster 24175:')
    for (const article of clusterArticles.rows) {
      console.log(`  ${article.id}: "${article.title}"`)
      console.log(`    URL: ${article.canonical_url}`)
      console.log(`    Publisher Homepage: ${article.publisher_homepage}`)
      console.log(`    Publisher Host: ${article.publisher_host}`)
    }

    // Check the lead article's domain
    const leadArticle = await query<{
      id: number
      canonical_url: string
      publisher_homepage: string | null
      publisher_host: string | null
    }>(
      `SELECT 
         id,
         canonical_url,
         publisher_homepage,
         publisher_host
       FROM articles
       WHERE id = $1`,
      [ourCluster.lead_article_id]
    )

    if (leadArticle.rows.length > 0) {
      const lead = leadArticle.rows[0]
      console.log(`\n🎯 Lead article ${lead.id} domain info:`)
      console.log(`  URL: ${lead.canonical_url}`)
      console.log(`  Publisher Homepage: ${lead.publisher_homepage}`)
      console.log(`  Publisher Host: ${lead.publisher_host}`)
    }
  }
}

// Run the debug
debugFrontendData()
  .then(() => {
    console.log('\n🔍 Frontend data debug complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Frontend data debug failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
