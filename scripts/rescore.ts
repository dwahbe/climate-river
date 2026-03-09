// scripts/rescore.ts
import { query, endPool } from "@/lib/db";

const HOUR = 3600;
// Optimized decay for dynamic, fresh content (data-driven analysis)
const HL_ARTICLE_H = 6; // 6h half-life: articles lose 50% score every 6 hours
const HL_CLUSTER_H = 9; // 9h half-life: clusters decay 25% faster for fresher homepage

export async function run(opts: { closePool?: boolean } = {}) {
  console.log("🔄 Starting rescore process...");

  // ensure table
  console.log("📋 Ensuring cluster_scores table exists...");
  await query(`
    CREATE TABLE IF NOT EXISTS cluster_scores (
      cluster_id       bigint PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
      size             int    NOT NULL,
      score            double precision NOT NULL,
      lead_article_id  bigint REFERENCES articles(id)
    );
  `);
  console.log("✅ Table ensured");

  console.log("🔄 Starting main rescore query...");
  console.log(
    `⏰ Using half-lives: Articles=${HL_ARTICLE_H}h, Clusters=${HL_CLUSTER_H}h`,
  );

  await query(
    `
    WITH art AS (
      SELECT
        cluster_id,
        article_id,
        published_at,
        dek,
        author,
        canonical_url,
        src_weight,
        is_gn,
        is_wire
      FROM (
        SELECT
          ac.cluster_id,
          a.id AS article_id,
          a.published_at,
          a.dek,
          a.author,
          a.canonical_url,
          COALESCE(s.weight, 3)         AS src_weight,
          -- penalties (ints, not booleans)
          (a.canonical_url LIKE 'https://news.google.com%')::int                             AS is_gn,
          (a.canonical_url ~ '(prnewswire|businesswire)\\.com')::int                          AS is_wire,
          ROW_NUMBER() OVER (
            PARTITION BY a.id
            ORDER BY ac.cluster_id
          ) AS article_cluster_rank
        FROM article_clusters ac
        JOIN articles a ON a.id = ac.article_id
        LEFT JOIN sources s ON s.id = a.source_id
      ) ranked
      WHERE article_cluster_rank = 1
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
        -- article_score: give MUCH more weight to freshness
        (0.40 * editorial_q) + (0.60 * fresh) AS article_score
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
        -- velocity = how many articles in last 4h (shorter window for more recent focus)
        SUM( ((now() - a.published_at) <= interval '4 hours')::int )     AS v4
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
        c.v4,
        -- coverage: capped to prevent mega-clusters from dominating
        ( LN(1 + LEAST(COALESCE(c.sum_w,0), 50))
          + 0.8*LN(1 + LEAST(COALESCE(c.distinct_sources,0), 10))
          + 0.4*LN(1 + LEAST(COALESCE(c.size,0), 15))
        ) AS coverage,
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
    final_base AS (
      SELECT
        cluster_id,
        size,
        -- Blend: 51% freshness, 27% velocity, 12% coverage (capped), 5% avg_weight, 5% pool
        (0.12 * coverage) + (0.05 * avg_w) + (0.27 * LN(1 + v4)) + (0.51 * fresh)
          + 0.05 * LN(1 + pool_strength) AS score,
        lead_article_id
      FROM clust_scored
    ),
    final_ranked AS (
      SELECT
        final_base.*,
        ROW_NUMBER() OVER (
          PARTITION BY final_base.lead_article_id
          ORDER BY final_base.score DESC NULLS LAST, final_base.cluster_id
        ) AS lead_rank
      FROM final_base
    ),
    final AS (
      SELECT
        cluster_id,
        size,
        score,
        CASE
          WHEN lead_article_id IS NULL THEN NULL
          WHEN lead_rank = 1 THEN lead_article_id
          ELSE NULL
        END AS lead_article_id
      FROM final_ranked
    )
    INSERT INTO cluster_scores (cluster_id, size, score, lead_article_id)
    SELECT cluster_id, size, score, lead_article_id FROM final
    ON CONFLICT (cluster_id) DO UPDATE
      SET size = EXCLUDED.size,
          score = EXCLUDED.score,
          lead_article_id = EXCLUDED.lead_article_id;
    `,
    [HL_ARTICLE_H, HL_CLUSTER_H],
  );

  console.log("✅ Main rescore query completed");

  // Cluster health check
  const health = await logClusterHealth();

  console.log("🎯 Rescore process finished successfully!");

  if (opts.closePool) await endPool();
  return { ok: true, health };
}

type ClusterHealth = {
  total_clusters: number;
  singletons: number;
  small: number;
  medium: number;
  large: number;
  oversized: number;
  max_size: number;
  embedded_pct: number;
};

async function logClusterHealth(): Promise<ClusterHealth> {
  const { rows } = await query<ClusterHealth>(`
    WITH cluster_sizes AS (
      SELECT ac.cluster_id, COUNT(*) AS size
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.fetched_at >= now() - interval '7 days'  -- wider than LOOKBACK_DAYS for broader health view
      GROUP BY ac.cluster_id
    ),
    embed_stats AS (
      SELECT
        ROUND(100.0 * COUNT(*) FILTER (WHERE embedding IS NOT NULL) / GREATEST(COUNT(*), 1), 1) AS embedded_pct
      FROM articles
      WHERE fetched_at >= now() - interval '7 days'  -- wider than LOOKBACK_DAYS for broader health view
    )
    SELECT
      COUNT(*)::int AS total_clusters,
      COUNT(*) FILTER (WHERE size = 1)::int AS singletons,
      COUNT(*) FILTER (WHERE size BETWEEN 2 AND 5)::int AS small,
      COUNT(*) FILTER (WHERE size BETWEEN 6 AND 15)::int AS medium,
      COUNT(*) FILTER (WHERE size BETWEEN 16 AND 25)::int AS large,
      COUNT(*) FILTER (WHERE size > 25)::int AS oversized,
      COALESCE(MAX(size), 0)::int AS max_size,
      (SELECT embedded_pct FROM embed_stats)::float AS embedded_pct
    FROM cluster_sizes
  `);

  const h = rows[0];
  console.log("\n📊 Cluster Health:");
  console.log(
    `   Total: ${h.total_clusters} | Singletons: ${h.singletons} | 2-5: ${h.small} | 6-15: ${h.medium} | 16-25: ${h.large} | 25+: ${h.oversized}`,
  );
  console.log(
    `   Max size: ${h.max_size} | Embedding coverage: ${h.embedded_pct}%`,
  );

  if (h.oversized > 0) {
    console.warn(`   ⚠️  ${h.oversized} clusters exceed max size!`);
  }
  if (h.embedded_pct < 50) {
    console.warn(`   ⚠️  Low embedding coverage: ${h.embedded_pct}%`);
  }

  return h;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
