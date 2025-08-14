// scripts/rescore.ts
import { query, endPool } from '@/lib/db'

// Half-lives (tune)
const HOUR = 3600
const HL_ARTICLE_H = 24 // article freshness half-life (hours)
const HL_CLUSTER_H = 30 // cluster freshness half-life (hours)

export async function run(opts: { closePool?: boolean } = {}) {
  // Ensure table exists (idempotent)
  await query(`
    CREATE TABLE IF NOT EXISTS cluster_scores (
      cluster_id       bigint PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
      size             int    NOT NULL,
      score            double precision NOT NULL,
      lead_article_id  bigint REFERENCES articles(id)
    );
  `)

  // Compute and upsert scores in one SQL
  await query(
    `
    WITH art AS (
      SELECT
        ac.cluster_id,
        a.id                         AS article_id,
        a.published_at,
        a.dek,
        a.author,
        a.canonical_url,
        COALESCE(s.weight, 3)        AS src_weight,
        -- clicks in last 48h
        COALESCE((
          SELECT COUNT(*) FROM article_events e
          WHERE e.article_id = a.id AND e.created_at >= now() - interval '48 hours'
        ), 0)                         AS clicks48,
        -- penalties
        (a.canonical_url LIKE 'https://news.google.com%')::int AS is_gn,
        (a.canonical_url ~ '(prnewswire|businesswire)\\.com')::int AS is_wire
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      LEFT JOIN sources s ON s.id = a.source_id
    ),
    art_scored AS (
      SELECT
        article_id,
        cluster_id,

        -- freshness: exp( ln(0.5) * age / HL )
        EXP( LN(0.5) * EXTRACT(EPOCH FROM (now() - COALESCE(published_at, now()))) / ($1 * ${HOUR}) ) AS fresh,

        -- base quality from source + author + dek
        (COALESCE(src_weight, 3))                            -- source quality
        + CASE WHEN NULLIF(TRIM(COALESCE(author,'')), '') IS NOT NULL THEN 0.25 ELSE 0 END
        + CASE WHEN LENGTH(COALESCE(dek,'')) >= 120 THEN 0.10 ELSE 0 END
        - (is_gn * 0.40)  -- demote aggregator
        - (is_wire * 0.50)  -- demote press releases
        AS base_quality,

        -- attention from clicks (diminishing returns)
        LN(1 + clicks48) AS attn
      FROM art
    ),
    art_final AS (
      SELECT
        article_id,
        cluster_id,
        GREATEST(0.0,
          (0.65 * base_quality) +  -- editorial quality
          (0.35 * attn)            -- real attention
        ) * fresh AS article_score
      FROM art_scored
    ),
    clust AS (
      SELECT
        a.cluster_id,
        COUNT(*)                                         AS size,
        MAX(a.published_at)                              AS latest_pub,
        SUM(a.src_weight)                                AS sum_w,
        AVG(a.src_weight)                                AS avg_w,
        -- velocity = new articles in last 6h
        SUM( (now() - a.published_at) <= interval '6 hours' )::int AS v6
      FROM art a
      GROUP BY a.cluster_id
    ),
    clust_scored AS (
      SELECT
        c.cluster_id,
        c.size,
        -- coverage + velocity (diminishing returns)
        (LN(1 + c.sum_w) + 0.6 * LN(1 + c.v6))          AS attention,
        -- cluster freshness
        EXP( LN(0.5) * EXTRACT(EPOCH FROM (now() - c.latest_pub)) / ($2 * ${HOUR}) ) AS fresh,
        c.avg_w                                         AS publisher_quality,
        -- lead article = max article_score
        (SELECT article_id FROM art_final af
         WHERE af.cluster_id = c.cluster_id
         ORDER BY af.article_score DESC NULLS LAST
         LIMIT 1)                                       AS lead_article_id,
        -- pooled article strength
        (SELECT COALESCE(SUM(article_score),0) FROM art_final af
         WHERE af.cluster_id = c.cluster_id)            AS pool_strength
      FROM clust c
    ),
    final AS (
      SELECT
        cluster_id,
        size,
        lead_article_id,
        -- final blend (tune weights)
        (0.45 * fresh) +
        (0.30 * attention) +
        (0.20 * publisher_quality) +
        (0.05 * LN(1 + pool_strength))                  AS score
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
