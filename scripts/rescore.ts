// scripts/rescore.ts
import './_env'
import { query, endPool } from '@/lib/db'

const HOUR = 3600
// Faster decay for more dynamic content (articles become "stale" quicker)
const HL_ARTICLE_H = 12 // 12 hours instead of 36
const HL_CLUSTER_H = 18 // 18 hours instead of 42

export async function run(opts: { closePool?: boolean } = {}) {
  // ensure table
  await query(`
    CREATE TABLE IF NOT EXISTS cluster_scores (
      cluster_id       bigint PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
      size             int    NOT NULL,
      score            double precision NOT NULL,
      lead_article_id  bigint REFERENCES articles(id)
    );
  `)

  await query(
    `
    WITH art AS (
      SELECT
        ac.cluster_id,
        a.id                          AS article_id,
        a.published_at,
        a.dek,
        a.author,
        a.canonical_url,
        COALESCE(s.weight, 3)         AS src_weight,
        -- penalties (ints, not booleans)
        (a.canonical_url LIKE 'https://news.google.com%')::int                             AS is_gn,
        (a.canonical_url ~ '(prnewswire|businesswire)\\.com')::int                          AS is_wire
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      LEFT JOIN sources s ON s.id = a.source_id
    ),
    art_scored AS (
      SELECT
        article_id,
        cluster_id,
        -- freshness: exp( ln(0.5) * age / HL ) with bounds to prevent overflow
        GREATEST(0.0001, EXP( LN(0.5) * LEAST(EXTRACT(EPOCH FROM (now() - COALESCE(published_at, now()))) / ($1 * ${HOUR}), 10) )) AS fresh,
        -- editorial quality (cold-start): source + author + dek - penalties
        (COALESCE(src_weight,3)) +
        CASE WHEN NULLIF(TRIM(COALESCE(author,'')), '') IS NOT NULL THEN 0.25 ELSE 0 END +
        CASE WHEN LENGTH(COALESCE(dek,'')) >= 120 THEN 0.10 ELSE 0 END
        - (is_gn * 0.50)  -- demote aggregator
        - (is_wire * 0.60) -- demote press releases
        AS editorial_q
      FROM art
    ),
    art_final AS (
      SELECT
        article_id,
        cluster_id,
        -- article_score: give much more weight to freshness
        (0.50 * editorial_q) + (0.50 * fresh) AS article_score
      FROM art_scored
    ),
    clust AS (
      SELECT
        a.cluster_id,
        COUNT(*)                                                         AS size,
        COUNT(DISTINCT s2.id)                                            AS distinct_sources,
        MAX(a.published_at)                                              AS latest_pub,
        SUM(COALESCE(a.src_weight,0))                                    AS sum_w,
        AVG(COALESCE(a.src_weight,0))                                    AS avg_w,
        -- velocity = how many articles in last 6h (CAST the boolean BEFORE SUM)
        SUM( ((now() - a.published_at) <= interval '6 hours')::int )     AS v6
      FROM art a
      LEFT JOIN article_clusters ac2 ON ac2.article_id = a.article_id
      LEFT JOIN articles a2 ON a2.id = ac2.article_id
      LEFT JOIN sources s2 ON s2.id = a2.source_id
      GROUP BY a.cluster_id
    ),
    clust_scored AS (
      SELECT
        c.cluster_id,
        c.size,
        c.distinct_sources,
        c.latest_pub,
        c.sum_w,
        c.avg_w,
        c.v6,
        -- coverage: more outlets + more total weighted coverage (use LN on 1+x for safety)
        ( LN(1 + COALESCE(c.sum_w,0)) + 0.8*LN(1 + COALESCE(c.distinct_sources,0)) + 0.4*LN(1 + COALESCE(c.size,0)) ) AS coverage,
        -- cluster freshness with bounds to prevent overflow
        GREATEST(0.0001, EXP( LN(0.5) * LEAST(EXTRACT(EPOCH FROM (now() - c.latest_pub)) / ($2 * ${HOUR}), 10) )) AS fresh,
        -- lead article by article_score
        (SELECT af.article_id
           FROM art_final af
          WHERE af.cluster_id = c.cluster_id
          ORDER BY af.article_score DESC NULLS LAST
          LIMIT 1) AS lead_article_id,
        -- pooled strength for a soft boost
        (SELECT COALESCE(SUM(af.article_score),0)
           FROM art_final af
          WHERE af.cluster_id = c.cluster_id) AS pool_strength
      FROM clust c
    ),
    final AS (
      SELECT
        cluster_id,
        -- blend: balance coverage, quality, and freshness more evenly
        (0.35 * coverage) + (0.15 * avg_w) + (0.20 * LN(1 + v6)) + (0.25 * fresh)
          + 0.05 * LN(1 + pool_strength) AS score,
        lead_article_id,
        (SELECT size FROM clust c2 WHERE c2.cluster_id = clust_scored.cluster_id) AS size
      FROM clust_scored
    )
    INSERT INTO cluster_scores (cluster_id, size, score, lead_article_id)
    SELECT cluster_id, size, score, lead_article_id FROM final
    ON CONFLICT (cluster_id) DO UPDATE
      SET size = EXCLUDED.size,
          score = EXCLUDED.score,
          lead_article_id = EXCLUDED.lead_article_id;
    `,
    [HL_ARTICLE_H, HL_CLUSTER_H]
  )

  if (opts.closePool) await endPool()
  return { ok: true }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err)
    endPool().finally(() => process.exit(1))
  })
}
