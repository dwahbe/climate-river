// Use the exact same import as the frontend
import * as DB from '@/lib/db'

async function testExactFrontend() {
  console.log('🔍 Testing exact frontend database connection...')

  // Use the exact same parameters as the frontend
  const searchParams: { view?: string } = {}
  const isLatest = searchParams?.view === 'latest'
  const topWindowHours = 48
  const limit = 28

  console.log(`\n📊 Frontend parameters:`)
  console.log(`  isLatest: ${isLatest}`)
  console.log(`  topWindowHours: ${topWindowHours}`)
  console.log(`  limit: ${limit}`)

  try {
    // Use the exact same DB.query method as the frontend
    const { rows } = await DB.query<{
      cluster_id: number
      lead_article_id: number
      lead_title: string
      lead_url: string
      lead_dek: string | null
      lead_source: string | null
      lead_homepage: string | null
      lead_author: string | null
      published_at: string
      size: number
      score: number
      sources_count: number
      subs: any[]
      subs_total: number
    }>(
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
              AND (
                l.size > 1 OR -- Allow same outlet for semantic clusters (size > 1)
                host_norm <> (
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

    console.log(
      `\n📰 Found ${rows.length} clusters using frontend DB connection:`
    )

    // Debug the first few cluster IDs
    console.log(
      `  First 3 cluster IDs: ${rows
        .slice(0, 3)
        .map((r) => r.cluster_id)
        .join(', ')}`
    )

    // Find our cluster
    console.log(`  Looking for cluster 24175 in ${rows.length} results...`)
    const ourCluster = rows.find((r) => r.cluster_id == 24175) // Use == for type coercion
    console.log(`  Cluster 24175 found: ${!!ourCluster}`)

    // Check if the first row is our cluster
    if (rows.length > 0) {
      console.log(
        `  First cluster ID: ${rows[0].cluster_id} (type: ${typeof rows[0].cluster_id})`
      )
      console.log(
        `  Is first cluster our target (===): ${rows[0].cluster_id === 24175}`
      )
      console.log(
        `  Is first cluster our target (==): ${rows[0].cluster_id == 24175}`
      )
    }

    if (ourCluster) {
      console.log(`\n🎯 Found our cluster 24175:`)
      console.log(
        `  Position: ${rows.findIndex((r) => r.cluster_id == 24175) + 1}`
      )
      console.log(`  Lead Article ID: ${ourCluster.lead_article_id}`)
      console.log(`  Title: "${ourCluster.lead_title}"`)
      console.log(`  Size: ${ourCluster.size}`)
      console.log(`  Score: ${ourCluster.score}`)
      console.log(`  Subs Total: ${ourCluster.subs_total}`)
      console.log(`  Subs Array Length: ${ourCluster.subs.length}`)
      console.log(`  Subs Array: ${JSON.stringify(ourCluster.subs, null, 2)}`)

      // Frontend logic
      const secondaries = ourCluster.subs ?? []
      const isCluster = ourCluster.size > 1
      const hasSubs = secondaries.length > 0

      console.log('\n🔍 Frontend rendering logic:')
      console.log(`  isCluster (size > 1): ${isCluster}`)
      console.log(`  hasSubs (subs.length > 0): ${hasSubs}`)
      console.log(`  Will show "Read more": ${isCluster && hasSubs}`)

      if (!hasSubs) {
        console.log(
          '\n❌ No secondary articles found! This is why "Read more" is not showing.'
        )
      }
    } else {
      console.log(`\n❌ Our cluster 24175 NOT found in frontend results!`)

      // Show first 5 results
      console.log('\n📋 First 5 clusters:')
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const row = rows[i]
        console.log(
          `  ${i + 1}. Cluster ${row.cluster_id}: "${row.lead_title}" (size: ${row.size})`
        )
      }
    }
  } catch (error) {
    console.error('❌ Frontend query failed:', error)
  }
}

// Run the test
testExactFrontend()
  .then(() => {
    console.log('\n🔍 Exact frontend test complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Exact frontend test failed:', error)
    process.exit(1)
  })
  .finally(() => {
    DB.endPool()
  })
