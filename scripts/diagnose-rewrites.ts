// scripts/diagnose-rewrites.ts
// Diagnostic tool to understand rewrite pipeline health
import { query, endPool } from '@/lib/db'

type DiagnosticResult = {
  section: string
  data: Record<string, unknown>
}

const results: DiagnosticResult[] = []

function log(section: string, data: Record<string, unknown>) {
  results.push({ section, data })
  console.log(`\n📊 ${section}`)
  console.log('─'.repeat(60))
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      console.log(`  ${key}:`)
      value.forEach((v) => console.log(`    - ${JSON.stringify(v)}`))
    } else {
      console.log(`  ${key}: ${JSON.stringify(value)}`)
    }
  }
}

async function diagnoseContentPipeline() {
  // 1. Content status distribution
  const { rows: contentStatus } = await query<{
    content_status: string | null
    count: string
  }>(`
    SELECT 
      COALESCE(content_status, 'null') as content_status,
      COUNT(*) as count
    FROM articles
    WHERE COALESCE(published_at, NOW()) > NOW() - INTERVAL '21 days'
    GROUP BY content_status
    ORDER BY count DESC
  `)

  const total = contentStatus.reduce((sum, r) => sum + parseInt(r.count), 0)
  const successCount =
    contentStatus.find((r) => r.content_status === 'success')?.count || '0'
  const successRate = ((parseInt(successCount) / total) * 100).toFixed(1)

  log('Content Pipeline Health', {
    total_recent_articles: total,
    content_fetch_success_rate: `${successRate}%`,
    status_breakdown: contentStatus.map(
      (r) => `${r.content_status}: ${r.count}`
    ),
  })

  return { total, successRate: parseFloat(successRate) }
}

async function diagnoseRewriteStatus() {
  // 2. Rewrite status overview
  const { rows: rewriteStatus } = await query<{
    has_rewrite: boolean
    count: string
  }>(`
    SELECT 
      (rewritten_title IS NOT NULL) as has_rewrite,
      COUNT(*) as count
    FROM articles
    WHERE COALESCE(published_at, NOW()) > NOW() - INTERVAL '21 days'
      AND EXISTS (SELECT 1 FROM article_categories ac WHERE ac.article_id = articles.id)
    GROUP BY (rewritten_title IS NOT NULL)
  `)

  const withRewrite = parseInt(
    rewriteStatus.find((r) => r.has_rewrite)?.count || '0'
  )
  const withoutRewrite = parseInt(
    rewriteStatus.find((r) => !r.has_rewrite)?.count || '0'
  )
  const rewriteRate = ((withRewrite / (withRewrite + withoutRewrite)) * 100).toFixed(1)

  log('Rewrite Coverage', {
    articles_with_rewrite: withRewrite,
    articles_without_rewrite: withoutRewrite,
    rewrite_rate: `${rewriteRate}%`,
  })

  return { withRewrite, withoutRewrite, rewriteRate: parseFloat(rewriteRate) }
}

async function diagnoseFailureModes() {
  // 3. Failure mode breakdown
  const { rows: failureModes } = await query<{
    failure_category: string
    count: string
    example_note: string
  }>(`
    WITH categorized AS (
      SELECT 
        id,
        rewrite_notes,
        CASE
          WHEN rewrite_notes LIKE '%not_climate%' THEN 'not_climate'
          WHEN rewrite_notes LIKE '%paywall%' THEN 'paywall'
          WHEN rewrite_notes LIKE '%timeout%' THEN 'timeout'
          WHEN rewrite_notes LIKE '%blocked%' THEN 'blocked'
          WHEN rewrite_notes LIKE '%no_content%' THEN 'no_content'
          WHEN rewrite_notes LIKE '%content_rejected%' THEN 'content_quality_failed'
          WHEN rewrite_notes LIKE 'success%' THEN 'success'
          WHEN rewrite_notes IS NULL THEN 'not_attempted'
          ELSE 'other_failure'
        END as failure_category
      FROM articles
      WHERE COALESCE(published_at, NOW()) > NOW() - INTERVAL '21 days'
        AND EXISTS (SELECT 1 FROM article_categories ac WHERE ac.article_id = articles.id)
    )
    SELECT 
      failure_category,
      COUNT(*) as count,
      (SELECT rewrite_notes FROM categorized c2 WHERE c2.failure_category = categorized.failure_category LIMIT 1) as example_note
    FROM categorized
    GROUP BY failure_category
    ORDER BY count DESC
  `)

  log('Failure Mode Distribution', {
    breakdown: failureModes.map(
      (r) => `${r.failure_category}: ${r.count} (e.g. "${r.example_note?.slice(0, 50)}...")`
    ),
  })

  return failureModes
}

async function diagnosePaywallSources() {
  // 4. Which sources have content issues?
  const { rows: sourceIssues } = await query<{
    source: string
    total: string
    success: string
    paywall: string
    blocked: string
    timeout: string
  }>(`
    SELECT 
      COALESCE(a.publisher_name, s.name, 'Unknown') as source,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE content_status = 'success') as success,
      COUNT(*) FILTER (WHERE content_status = 'paywall') as paywall,
      COUNT(*) FILTER (WHERE content_status = 'blocked') as blocked,
      COUNT(*) FILTER (WHERE content_status = 'timeout') as timeout
    FROM articles a
    LEFT JOIN sources s ON s.id = a.source_id
    WHERE COALESCE(a.published_at, NOW()) > NOW() - INTERVAL '21 days'
    GROUP BY COALESCE(a.publisher_name, s.name, 'Unknown')
    HAVING COUNT(*) >= 5
    ORDER BY 
      (COUNT(*) FILTER (WHERE content_status != 'success')::float / COUNT(*)) DESC
    LIMIT 15
  `)

  log('Sources with Content Issues (top 15 by failure rate)', {
    sources: sourceIssues.map((r) => ({
      source: r.source,
      total: r.total,
      success: r.success,
      issues: `paywall:${r.paywall} blocked:${r.blocked} timeout:${r.timeout}`,
    })),
  })

  return sourceIssues
}

async function diagnoseRewriteQuality() {
  // 5. Sample recent rewrites for quality review
  const { rows: recentRewrites } = await query<{
    id: number
    original: string
    rewritten: string
    source: string
    notes: string
  }>(`
    SELECT 
      a.id,
      a.title as original,
      a.rewritten_title as rewritten,
      COALESCE(a.publisher_name, s.name) as source,
      a.rewrite_notes as notes
    FROM articles a
    LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.rewritten_title IS NOT NULL
      AND a.rewritten_at > NOW() - INTERVAL '24 hours'
    ORDER BY a.rewritten_at DESC
    LIMIT 10
  `)

  log('Recent Rewrites (last 24h sample)', {
    count: recentRewrites.length,
    samples: recentRewrites.map((r) => ({
      id: r.id,
      source: r.source,
      original: r.original?.slice(0, 60) + '...',
      rewritten: r.rewritten?.slice(0, 60) + '...',
    })),
  })
}

async function diagnoseUnrewrittenOpportunities() {
  // 6. High-value articles that failed rewrite
  const { rows: opportunities } = await query<{
    id: number
    title: string
    source: string
    score: number | null
    content_status: string | null
    rewrite_notes: string | null
  }>(`
    SELECT 
      a.id,
      a.title,
      COALESCE(a.publisher_name, s.name) as source,
      cs.score,
      a.content_status,
      a.rewrite_notes
    FROM articles a
    LEFT JOIN sources s ON s.id = a.source_id
    LEFT JOIN cluster_scores cs ON cs.lead_article_id = a.id
    WHERE a.rewritten_title IS NULL
      AND COALESCE(a.published_at, NOW()) > NOW() - INTERVAL '21 days'
      AND EXISTS (SELECT 1 FROM article_categories ac WHERE ac.article_id = a.id)
      AND cs.score IS NOT NULL
    ORDER BY cs.score DESC
    LIMIT 15
  `)

  log('High-Value Unrewritten Articles (by cluster score)', {
    opportunities: opportunities.map((r) => ({
      id: r.id,
      score: r.score,
      source: r.source,
      title: r.title?.slice(0, 50) + '...',
      content_status: r.content_status || 'null',
      failure: r.rewrite_notes?.slice(0, 40) || 'not_attempted',
    })),
  })
}

async function diagnoseContentQuality() {
  // 7. Check articles where content was fetched but snippet extraction failed
  const { rows: contentIssues } = await query<{
    id: number
    title: string
    content_length: number
    first_200: string
  }>(`
    SELECT 
      a.id,
      a.title,
      LENGTH(a.content_text) as content_length,
      LEFT(a.content_text, 200) as first_200
    FROM articles a
    WHERE a.content_status = 'success'
      AND a.rewritten_title IS NULL
      AND a.rewrite_notes LIKE '%content_rejected%'
      AND COALESCE(a.published_at, NOW()) > NOW() - INTERVAL '21 days'
    ORDER BY a.fetched_at DESC
    LIMIT 10
  `)

  log('Content Extraction Failures (success status but rejected)', {
    count: contentIssues.length,
    samples: contentIssues.map((r) => ({
      id: r.id,
      title: r.title?.slice(0, 40) + '...',
      content_length: r.content_length,
      first_200_preview: r.first_200?.slice(0, 100) + '...',
    })),
  })
}

async function diagnoseNonClimateRejections() {
  // 8. Check non-climate rejections - are they correct?
  const { rows: nonClimate } = await query<{
    id: number
    title: string
    source: string
    categories: string[]
  }>(`
    SELECT 
      a.id,
      a.title,
      COALESCE(a.publisher_name, s.name) as source,
      ARRAY_AGG(c.slug) as categories
    FROM articles a
    LEFT JOIN sources s ON s.id = a.source_id
    LEFT JOIN article_categories ac ON ac.article_id = a.id
    LEFT JOIN categories c ON c.id = ac.category_id
    WHERE a.rewrite_notes LIKE '%not_climate%'
      AND COALESCE(a.published_at, NOW()) > NOW() - INTERVAL '7 days'
    GROUP BY a.id, a.title, COALESCE(a.publisher_name, s.name)
    ORDER BY a.fetched_at DESC
    LIMIT 15
  `)

  log('Non-Climate Rejections Review (are these correct?)', {
    count: nonClimate.length,
    samples: nonClimate.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title?.slice(0, 60) + '...',
      categories: r.categories?.join(', ') || 'none',
    })),
  })
}

async function generateSummary() {
  // Generate actionable summary
  const { rows: summary } = await query<{
    metric: string
    value: string
  }>(`
    WITH stats AS (
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE rewritten_title IS NOT NULL) as rewritten,
        COUNT(*) FILTER (WHERE content_status = 'success') as has_content,
        COUNT(*) FILTER (WHERE rewritten_title IS NOT NULL AND content_status = 'success') as rewritten_with_content,
        COUNT(*) FILTER (WHERE rewrite_notes LIKE '%not_climate%') as non_climate,
        COUNT(*) FILTER (WHERE content_status = 'paywall') as paywall,
        COUNT(*) FILTER (WHERE content_status = 'blocked') as blocked,
        COUNT(*) FILTER (WHERE rewrite_notes IS NULL AND rewritten_title IS NULL) as not_attempted
      FROM articles
      WHERE COALESCE(published_at, NOW()) > NOW() - INTERVAL '21 days'
        AND EXISTS (SELECT 1 FROM article_categories ac WHERE ac.article_id = articles.id)
    )
    SELECT 'Total categorized articles (21d)' as metric, total::text as value FROM stats
    UNION ALL SELECT 'Rewritten', rewritten::text FROM stats
    UNION ALL SELECT 'Rewrite rate', ROUND(rewritten::numeric * 100 / NULLIF(total, 0), 1) || '%' FROM stats
    UNION ALL SELECT 'Has content (success)', has_content::text FROM stats
    UNION ALL SELECT 'Rewritten WITH content', rewritten_with_content::text FROM stats
    UNION ALL SELECT 'Rejected as non-climate', non_climate::text FROM stats
    UNION ALL SELECT 'Content blocked/paywalled', (paywall + blocked)::text FROM stats
    UNION ALL SELECT 'Not yet attempted', not_attempted::text FROM stats
  `)

  console.log('\n' + '═'.repeat(60))
  console.log('📈 EXECUTIVE SUMMARY')
  console.log('═'.repeat(60))
  for (const row of summary) {
    console.log(`  ${row.metric.padEnd(35)} ${row.value}`)
  }
  console.log('═'.repeat(60))
}

async function main() {
  console.log('🔍 Climate River Rewrite Pipeline Diagnostics')
  console.log('=' .repeat(60))
  console.log('Running comprehensive analysis...\n')

  try {
    await diagnoseContentPipeline()
    await diagnoseRewriteStatus()
    await diagnoseFailureModes()
    await diagnosePaywallSources()
    await diagnoseRewriteQuality()
    await diagnoseUnrewrittenOpportunities()
    await diagnoseContentQuality()
    await diagnoseNonClimateRejections()
    await generateSummary()

    console.log('\n✅ Diagnostics complete!')
  } catch (error) {
    console.error('❌ Error running diagnostics:', error)
  } finally {
    await endPool()
  }
}

main()

