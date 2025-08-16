import { query, endPool } from '@/lib/db'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

async function checkHostNorm() {
  console.log('🔍 Checking host normalization for our articles...')

  // Check the host normalization values for both articles
  const hostResult = await query<{
    id: number
    title: string
    canonical_url: string
    publisher_homepage: string | null
    publisher_host: string | null
    computed_host_norm: string
  }>(
    `SELECT 
       a.id,
       a.title,
       a.canonical_url,
       a.publisher_homepage,
       a.publisher_host,
       COALESCE(
         a.publisher_host,
         regexp_replace(
           lower(
             regexp_replace(
               COALESCE(a.publisher_homepage, a.canonical_url),
               '^https?://([^/]+).*$',
               '\\1'
             )
           ),
           '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\.',
           ''
         )
       ) AS computed_host_norm
     FROM articles a
     WHERE a.id IN (35784, 35790)
     ORDER BY a.id`
  )

  console.log('\n📰 Host normalization results:')
  for (const article of hostResult.rows) {
    console.log(`\nArticle ${article.id}: "${article.title}"`)
    console.log(`  URL: ${article.canonical_url}`)
    console.log(`  Publisher Homepage: ${article.publisher_homepage}`)
    console.log(`  Publisher Host: ${article.publisher_host}`)
    console.log(`  Computed Host Norm: "${article.computed_host_norm}"`)
  }

  // Check if they have the same host_norm
  if (hostResult.rows.length === 2) {
    const [article1, article2] = hostResult.rows
    const sameHost = article1.computed_host_norm === article2.computed_host_norm

    console.log(`\n🔍 Same host_norm: ${sameHost}`)
    if (sameHost) {
      console.log(
        `❌ Both articles have host_norm "${article1.computed_host_norm}"`
      )
      console.log(
        `   This is why the second article is filtered out from the subs array.`
      )
      console.log(
        `   The frontend query excludes articles from the same outlet.`
      )
    } else {
      console.log(`✅ Different host_norm values - they should both appear`)
    }
  }

  // Test the exact subs query for our cluster
  console.log('\n🔍 Testing the subs query for cluster 24175...')

  const subsResult = await query<{
    article_id: number
    title: string
    url: string
    source: string | null
    author: string | null
    published_at: string
    host_norm: string
    lead_host_norm: string
  }>(
    `WITH x AS (
       SELECT
         a2.id            AS article_id,
         a2.title,
         a2.canonical_url AS url,
         COALESCE(a2.publisher_name, s2.name) AS source,
         a2.author,
         a2.published_at,

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

         (SELECT COALESCE(
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
         WHERE lead_a.id = 35784) AS lead_host_norm

       FROM article_clusters ac2
       JOIN articles a2 ON a2.id = ac2.article_id
       LEFT JOIN sources s2 ON s2.id = a2.source_id
       WHERE ac2.cluster_id = 24175
         AND a2.id <> 35784
     )
     SELECT 
       article_id, title, url, source, author, published_at, host_norm, lead_host_norm
     FROM x
     WHERE url NOT LIKE 'https://news.google.com%'
       AND url NOT LIKE 'https://news.yahoo.com%'
       AND url NOT LIKE 'https://www.msn.com%'
       AND host_norm NOT IN ('news.google.com', 'news.yahoo.com', 'msn.com')
       AND (
         2 > 1 OR -- Allow same outlet for semantic clusters (size > 1) - hardcoded for testing
         host_norm <> lead_host_norm
       )`
  )

  console.log(`\n📊 Subs query results (${subsResult.rows.length} articles):`)
  if (subsResult.rows.length === 0) {
    console.log('  ❌ No articles found - this confirms the filtering issue')
  } else {
    for (const sub of subsResult.rows) {
      console.log(`  Article ${sub.article_id}: "${sub.title}"`)
      console.log(`    Host norm: "${sub.host_norm}"`)
      console.log(`    Lead host norm: "${sub.lead_host_norm}"`)
      console.log(`    Same host: ${sub.host_norm === sub.lead_host_norm}`)
    }
  }
}

// Run the check
checkHostNorm()
  .then(() => {
    console.log('\n🔍 Host normalization check complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Host normalization check failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
