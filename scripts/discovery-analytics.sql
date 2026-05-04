-- discovery analytics queries
--
-- Run via Supabase SQL editor or psql. These queries compare provider
-- behavior using the discovery_searches + discovery_candidates tables added
-- in scripts/schema.ts. Run the discover-web pipeline for a few days first
-- so the tables have meaningful volume.

-- =============================================================================
-- 1) Per-provider yield, cost, and acceptance rate (last 7 days)
-- =============================================================================
-- Answers: "What's our $/inserted for Tavily vs OpenAI vs Google News?"
WITH search_rollup AS (
  SELECT
    provider,
    COUNT(*)                         AS searches,
    SUM(cost_usd)::numeric(10, 4)    AS total_cost_usd,
    ROUND(AVG(latency_ms))           AS avg_latency_ms,
    SUM(tool_calls)                  AS total_tool_calls
  FROM discovery_searches
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY provider
),
candidate_rollup AS (
  SELECT
    provider,
    COUNT(*)                                  AS candidates,
    COUNT(*) FILTER (WHERE accepted = true)  AS inserted
  FROM discovery_candidates
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY provider
)
SELECT
  s.provider,
  s.searches,
  s.total_cost_usd,
  COALESCE(c.candidates, 0)                   AS candidates,
  COALESCE(c.inserted, 0)                     AS inserted,
  ROUND(
    100.0 * COALESCE(c.inserted, 0)
          / NULLIF(COALESCE(c.candidates, 0), 0),
    1
  )                                                   AS accept_pct,
  ROUND(
    s.total_cost_usd::numeric
      / NULLIF(COALESCE(c.inserted, 0), 0),
    4
  )                                                   AS cost_per_insert_usd,
  s.avg_latency_ms,
  s.total_tool_calls
FROM search_rollup s
LEFT JOIN candidate_rollup c ON c.provider = s.provider
ORDER BY total_cost_usd DESC;

-- =============================================================================
-- 2) Rejection-reason distribution per provider (last 7 days)
-- =============================================================================
-- Answers: "Why do we lose candidates? Are stale results the dominant failure?
--          Is one provider returning more fabricated URLs?"
WITH grouped AS (
  SELECT
    provider,
    COALESCE(rejection_reason, 'inserted') AS outcome,
    COUNT(*)                               AS n
  FROM discovery_candidates
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY provider, COALESCE(rejection_reason, 'inserted')
)
SELECT
  provider,
  outcome,
  n,
  ROUND(
    100.0 * n / SUM(n) OVER (PARTITION BY provider),
    1
  )                                                   AS pct_of_provider
FROM grouped
ORDER BY provider, n DESC;

-- =============================================================================
-- 3) Cross-provider duplicates: who's finding what others already found?
-- =============================================================================
-- Answers: "Is OpenAI returning 50% duplicates of Tavily articles?
--          Could we drop the OpenAI fallback without losing unique inserts?"
SELECT
  c.provider,
  COUNT(*) FILTER (WHERE c.rejection_reason = 'duplicate_url')
    AS dupes_of_existing_articles,
  COUNT(*) FILTER (WHERE c.duplicate_article_id IS NOT NULL)
    AS dupes_with_known_origin,
  COUNT(*) FILTER (WHERE c.accepted = true)
    AS unique_inserts
FROM discovery_candidates c
WHERE c.created_at >= NOW() - INTERVAL '7 days'
GROUP BY c.provider
ORDER BY unique_inserts DESC;

-- =============================================================================
-- 4) Stale rate per provider (the freshness ceiling we measured in eval)
-- =============================================================================
-- Answers: "Is v4 prompt actually improving freshness compliance in production?
--          Is one provider's index more stale than another?"
SELECT
  c.provider,
  COUNT(*)                                                          AS candidates,
  COUNT(*) FILTER (WHERE c.rejection_reason IN ('stale','missing_date','invalid_date'))
    AS rejected_for_recency,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE c.rejection_reason IN ('stale','missing_date','invalid_date')
    ) / NULLIF(COUNT(*), 0),
    1
  )                                                                 AS recency_reject_pct
FROM discovery_candidates c
WHERE c.created_at >= NOW() - INTERVAL '7 days'
GROUP BY c.provider
ORDER BY recency_reject_pct DESC;

-- =============================================================================
-- 5) Top hosts by accepted count (last 7 days)
-- =============================================================================
-- Answers: "Which outlets are actually feeding us articles? Should we trim
--          the long tail of low-yield outlets from CURATED_CLIMATE_OUTLETS?"
SELECT
  c.host,
  COUNT(*) FILTER (WHERE c.accepted = true)        AS inserted,
  COUNT(*)                                          AS candidates,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE c.accepted = true)
          / NULLIF(COUNT(*), 0),
    1
  )                                                 AS accept_pct,
  STRING_AGG(DISTINCT c.provider, ', ')             AS providers
FROM discovery_candidates c
WHERE c.created_at >= NOW() - INTERVAL '7 days'
  AND c.host IS NOT NULL
GROUP BY c.host
HAVING COUNT(*) >= 3
ORDER BY inserted DESC, candidates DESC
LIMIT 30;

-- =============================================================================
-- 6) Hosts where the "unreachable" rejection fires
-- =============================================================================
-- Answers: "Which outlets are bot-blocking our HEAD checks (false positives
--          like Bloomberg) so we can decide whether to skip the reachability
--          check for them?"
SELECT
  c.host,
  COUNT(*) FILTER (WHERE c.rejection_reason = 'unreachable') AS unreachable_count,
  COUNT(*)                                                    AS total_candidates,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE c.rejection_reason = 'unreachable')
          / NULLIF(COUNT(*), 0),
    1
  )                                                           AS unreachable_pct
FROM discovery_candidates c
WHERE c.created_at >= NOW() - INTERVAL '7 days'
  AND c.host IS NOT NULL
GROUP BY c.host
HAVING COUNT(*) FILTER (WHERE c.rejection_reason = 'unreachable') > 0
ORDER BY unreachable_count DESC
LIMIT 25;

-- =============================================================================
-- 7) Run-level rollup (group searches into discovery runs by run_id)
-- =============================================================================
-- Answers: "What does a typical discovery run look like end to end? Are we
--          spending most of our budget on Tavily or OpenAI within a run?"
WITH search_rollup AS (
  SELECT
    run_id,
    MIN(created_at)                         AS started_at,
    COUNT(*)                                AS searches,
    ROUND(SUM(cost_usd)::numeric, 4)        AS cost_usd,
    STRING_AGG(DISTINCT provider, ', ')     AS providers_used
  FROM discovery_searches
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY run_id
),
candidate_rollup AS (
  SELECT
    s.run_id,
    COUNT(c.id)                                   AS candidates,
    COUNT(c.id) FILTER (WHERE c.accepted = true)  AS inserts
  FROM discovery_searches s
  LEFT JOIN discovery_candidates c ON c.discovery_search_id = s.id
  WHERE s.created_at >= NOW() - INTERVAL '7 days'
  GROUP BY s.run_id
)
SELECT
  s.run_id,
  s.started_at,
  s.searches,
  COALESCE(c.candidates, 0) AS candidates,
  COALESCE(c.inserts, 0)    AS inserts,
  s.cost_usd,
  s.providers_used
FROM search_rollup s
LEFT JOIN candidate_rollup c ON c.run_id = s.run_id
ORDER BY started_at DESC
LIMIT 20;

-- =============================================================================
-- 8) Did the v4 prompt + 4.1-mini change land? (track over time)
-- =============================================================================
-- Run before vs after deploy to compare. Look for: (a) lower stale-reject %,
-- (b) similar or higher accept_pct, (c) similar or lower cost_per_insert.
WITH search_rollup AS (
  SELECT
    date_trunc('day', created_at) AS day,
    provider,
    model,
    ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
  FROM discovery_searches
  WHERE created_at >= NOW() - INTERVAL '14 days'
    AND provider IN ('tavily', 'openai_web_search')
  GROUP BY 1, 2, 3
),
candidate_rollup AS (
  SELECT
    date_trunc('day', s.created_at) AS day,
    s.provider,
    s.model,
    COUNT(c.id)                                      AS candidates,
    COUNT(c.id) FILTER (WHERE c.accepted = true)     AS inserts,
    COUNT(c.id) FILTER (WHERE c.rejection_reason = 'stale')
      AS stale_rejections
  FROM discovery_searches s
  LEFT JOIN discovery_candidates c ON c.discovery_search_id = s.id
  WHERE s.created_at >= NOW() - INTERVAL '14 days'
    AND s.provider IN ('tavily', 'openai_web_search')
  GROUP BY 1, 2, 3
)
SELECT
  s.day,
  s.provider,
  s.model,
  COALESCE(c.candidates, 0) AS candidates,
  COALESCE(c.inserts, 0)    AS inserts,
  ROUND(
    100.0 * COALESCE(c.stale_rejections, 0)
          / NULLIF(COALESCE(c.candidates, 0), 0),
    1
  )                                                  AS stale_pct,
  ROUND(
    s.cost_usd::numeric / NULLIF(COALESCE(c.inserts, 0), 0),
    4
  )                                                  AS cost_per_insert_usd
FROM search_rollup s
LEFT JOIN candidate_rollup c
  ON c.day = s.day
 AND c.provider = s.provider
 AND c.model IS NOT DISTINCT FROM s.model
ORDER BY 1 DESC, 2;

-- =============================================================================
-- 9) Prefetch catchup verification (after deploying the prefetch fix)
-- =============================================================================
-- Answers: "Did the catchup pass actually pick up the never-attempted
--          backlog? The 84% NULL rate for web-discovered articles should
--          drop sharply after a few full-cron cycles."
SELECT
  CASE
    WHEN s.feed_url LIKE 'web://%' OR s.feed_url LIKE 'web-discovery://%'
      THEN 'web_discovered'
    ELSE 'rss'
  END                                                AS origin,
  COALESCE(a.content_status, 'never_attempted')      AS status,
  COUNT(*)                                            AS articles
FROM articles a
JOIN sources s ON s.id = a.source_id
WHERE a.fetched_at >= NOW() - INTERVAL '14 days'
GROUP BY 1, 2
ORDER BY 1, 2;
