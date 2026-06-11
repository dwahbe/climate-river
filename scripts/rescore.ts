// scripts/rescore.ts
import { query, endPool } from "@/lib/db";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { UNKNOWN_SOURCE_WEIGHT } from "@/config/sourceTiers";
import { LEAD_INELIGIBLE_SQL } from "@/lib/clustering";
import { AGGREGATOR_URL_SQL_REGEX } from "@/lib/aggregators";
import {
  HL_CLUSTER_H,
  NOVELTY_DISTANCE_CEIL,
  NOVELTY_DISTANCE_FLOOR,
  SCORE_WEIGHTS,
  clusterFreshnessSql,
} from "@/lib/scoring";

const HOUR = 3600;
// Optimized decay for dynamic, fresh content (data-driven analysis)
const HL_ARTICLE_H = 6; // 6h half-life: articles lose 50% score every 6 hours
// Cluster half-life (HL_CLUSTER_H) lives in lib/scoring.ts — it's shared with
// get_river_clusters, which recomputes the freshness term at read time.

// Only rescore clusters with a member fetched in this window — older clusters
// can never appear in the 168h serving window, so recomputing the full 45-day
// corpus on every run was wasted work (the dominant recurring query at ~23s).
const ACTIVE_DAYS = 10;

// Normalization constants — divide each blend term by its practical maximum so
// the documented weights (51% fresh / 27% velocity / 12% coverage / 5% avg_w /
// 5% pool) are the real contribution shares. coverage max =
// ln(101)+0.8·ln(11)+0.4·ln(16); velocity max = ln(1+10 distinct sources);
// pool max = ln(1+50). avg_w is divided by the max tier (10).
const COVERAGE_MAX = Math.log(101) + 0.8 * Math.log(11) + 0.4 * Math.log(16);
const VELOCITY_MAX = Math.log(11);
const POOL_MAX = Math.log(51);

export async function run(opts: { closePool?: boolean } = {}) {
  console.log("🔄 Starting rescore process...");

  // Ensure table. This MUST mirror the authoritative definition in
  // scripts/schema.ts (single source of truth) — previously the two diverged on
  // lead_article_id nullability and the updated_at column, which on a fresh DB
  // could leave the table without updated_at (breaking the score index and the
  // updated_at writes in clustering/cluster-maintenance).
  console.log("📋 Ensuring cluster_scores table exists...");
  await query(`
    CREATE TABLE IF NOT EXISTS cluster_scores (
      cluster_id      bigint PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
      lead_article_id bigint NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      size            int    NOT NULL DEFAULT 1,
      score           double precision NOT NULL DEFAULT 0,
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Serve-time freshness: base_score is the decay-free blend, latest_pub is the
  // cluster's newest article. get_river_clusters applies the cluster-freshness
  // decay to base_score at read time, so the homepage stays current at ISR
  // granularity (5min) instead of only when rescore runs (gaps up to 6h).
  await query(
    `ALTER TABLE cluster_scores ADD COLUMN IF NOT EXISTS base_score double precision NOT NULL DEFAULT 0;`,
  );
  await query(
    `ALTER TABLE cluster_scores ADD COLUMN IF NOT EXISTS latest_pub timestamptz;`,
  );
  await query(`ALTER TABLE cluster_scores ADD COLUMN IF NOT EXISTS why text;`);
  // Clustering v2: persisted centroid (maintained incrementally by
  // lib/clustering.ts; backfilled by schema.ts/cluster-maintenance). The
  // novelty term reads it — ensure the column exists even on a pre-v2 DB.
  await query(
    `ALTER TABLE clusters ADD COLUMN IF NOT EXISTS centroid vector(1536);`,
  );
  console.log("✅ Table ensured");

  console.log("🔄 Starting main rescore query...");
  console.log(
    `⏰ Using half-lives: Articles=${HL_ARTICLE_H}h, Clusters=${HL_CLUSTER_H}h`,
  );

  await query(
    `
    WITH active_clusters AS (
      -- Bound the whole computation to clusters with recent activity. Members
      -- older than the window are still included for size/coverage (the join
      -- below is on cluster_id), but fully-stale clusters are skipped.
      SELECT DISTINCT ac.cluster_id
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.fetched_at >= now() - make_interval(days => ${ACTIVE_DAYS})
    ),
    art AS (
      SELECT
        cluster_id,
        article_id,
        published_at,
        dek,
        author,
        canonical_url,
        source_id,
        src_weight,
        is_aggregator,
        is_wire,
        is_eligible_lead
      FROM (
        SELECT
          ac.cluster_id,
          a.id AS article_id,
          a.published_at,
          a.dek,
          a.author,
          a.canonical_url,
          a.source_id,
          COALESCE(s.weight, ${UNKNOWN_SOURCE_WEIGHT})         AS src_weight,
          -- penalties (ints, not booleans)
          (a.canonical_url ~* '${AGGREGATOR_URL_SQL_REGEX}')::int                             AS is_aggregator,
          (a.canonical_url ~ '(prnewswire|businesswire)\\.com')::int                          AS is_wire,
          -- lead eligibility (shared rule, lib/clustering.ts): aggregator URLs
          -- link to interstitials; suspect dates (published ≈ fetched) are
          -- usually parse failures. Such articles can still corroborate a
          -- cluster but should never be its displayed lead.
          (NOT ${LEAD_INELIGIBLE_SQL})::int                                                   AS is_eligible_lead,
          ROW_NUMBER() OVER (
            PARTITION BY a.id
            ORDER BY ac.cluster_id
          ) AS article_cluster_rank
        FROM article_clusters ac
        JOIN active_clusters acl ON acl.cluster_id = ac.cluster_id
        JOIN articles a ON a.id = ac.article_id
        LEFT JOIN sources s ON s.id = a.source_id
        WHERE ${visibleLanguagePredicate("a")}
      ) ranked
      WHERE article_cluster_rank = 1
    ),
    art_scored AS (
      SELECT
        article_id,
        cluster_id,
        is_eligible_lead,
        -- freshness: exp( ln(0.5) * age / HL ), clamped to (0, 1]. The LEAST(.,1)
        -- guards against future-dated articles (negative age → exponent >1),
        -- which would otherwise inflate the cluster's score/velocity.
        LEAST(1.0, GREATEST(0.0001, EXP( LN(0.5) * LEAST(EXTRACT(EPOCH FROM (now() - COALESCE(published_at, now()))) / ($1 * ${HOUR}), 10) ))) AS fresh,
        -- editorial quality (cold-start): source + author + dek - penalties
        (COALESCE(src_weight,${UNKNOWN_SOURCE_WEIGHT})) +
        CASE WHEN NULLIF(TRIM(COALESCE(author,'')), '') IS NOT NULL THEN 0.25 ELSE 0 END +
        CASE WHEN LENGTH(COALESCE(dek,'')) >= 120 THEN 0.10 ELSE 0 END
        - (is_aggregator * 0.50)  -- demote aggregator
        - (is_wire * 0.60) -- demote press releases
        AS editorial_q
      FROM art
    ),
    art_final AS (
      SELECT
        article_id,
        cluster_id,
        is_eligible_lead,
        -- article_score: freshness-heavy for cluster ranking & pool strength
        (0.40 * editorial_q) + (0.60 * fresh) AS article_score,
        -- lead_score: quality-heavy for lead article selection (Techmeme-style)
        (0.80 * editorial_q) + (0.20 * fresh) AS lead_score
      FROM art_scored
    ),
    clust AS (
      SELECT
        a.cluster_id,
        COUNT(*)                                                         AS size,
        COUNT(DISTINCT a.source_id)                                      AS distinct_sources,
        MAX(a.published_at)                                              AS latest_pub,
        SUM(COALESCE(a.src_weight,0))                                    AS sum_w,
        AVG(COALESCE(a.src_weight,0))                                    AS avg_w,
        -- velocity = distinct sources publishing in the last 4h. Counting
        -- DISTINCT sources (not raw articles) stops one outlet live-blogging
        -- from inflating velocity; the bounded window also excludes
        -- future-dated articles (which the old (now()-pub)<=4h test let in).
        COUNT(DISTINCT a.source_id) FILTER (
          WHERE a.published_at BETWEEN now() - interval '4 hours' AND now()
        )                                                                AS v4
      FROM art a
      GROUP BY a.cluster_id
    ),
    -- Reference set for the novelty boost: centroids of the current top-scored
    -- recently-active clusters. A cluster far from ALL of these is covering
    -- something the river isn't already showing.
    top_centroids AS (
      SELECT cl.centroid
      FROM cluster_scores cs
      JOIN clusters cl ON cl.id = cs.cluster_id
      WHERE cl.centroid IS NOT NULL
        AND cs.latest_pub >= now() - interval '72 hours'
      ORDER BY cs.score DESC
      LIMIT 20
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
        -- coverage normalized to [0,1] (capped so mega-clusters can't dominate)
        ( LN(1 + LEAST(COALESCE(c.sum_w,0), 100))
          + 0.8*LN(1 + LEAST(COALESCE(c.distinct_sources,0), 10))
          + 0.4*LN(1 + LEAST(COALESCE(c.size,0), 15))
        ) / ${COVERAGE_MAX} AS coverage_norm,
        -- velocity normalized to [0,1]
        LN(1 + LEAST(COALESCE(c.v4,0), 10)) / ${VELOCITY_MAX} AS velocity_norm,
        -- avg source weight normalized to [0,1] (max tier = 10)
        LEAST(COALESCE(c.avg_w,0), 10) / 10.0 AS avg_w_norm,
        -- novelty normalized to [0,1]: cosine distance from the nearest current
        -- top cluster, ramped between NOVELTY_DISTANCE_FLOOR and _CEIL (see
        -- lib/scoring.ts for the live calibration). Incumbent top clusters
        -- score 0 (distance to self); clusters without a centroid get no boost.
        COALESCE(LEAST(1.0, GREATEST(0.0,
          ((SELECT MIN(cl.centroid <=> t.centroid) FROM top_centroids t)
            - ${NOVELTY_DISTANCE_FLOOR})
            / ${NOVELTY_DISTANCE_CEIL - NOVELTY_DISTANCE_FLOOR}
        )), 0.0) AS novelty_norm,
        -- lead article: prefer eligible (real-URL, good-date) articles, then
        -- editorial quality, freshness as tiebreak, article_id for determinism.
        (SELECT af.article_id
           FROM art_final af
          WHERE af.cluster_id = c.cluster_id
          ORDER BY af.is_eligible_lead DESC, af.lead_score DESC NULLS LAST, af.article_id
          LIMIT 1) AS lead_article_id,
        -- pooled strength normalized to [0,1]
        LN(1 + LEAST(
          (SELECT COALESCE(SUM(af.article_score),0)
             FROM art_final af
            WHERE af.cluster_id = c.cluster_id), 50)) / ${POOL_MAX} AS pool_norm
      FROM clust c
      LEFT JOIN clusters cl ON cl.id = c.cluster_id
    ),
    -- NOTE: every clust row has ≥1 art member (clust GROUPs art), so the lead
    -- subquery always returns a row, and the art CTE assigns each article to
    -- exactly one cluster, so two clusters can never elect the same lead. No
    -- dedup ranking is needed here.
    final AS (
      SELECT
        cluster_id,
        size,
        latest_pub,
        -- Decay-free base (stored): velocity/coverage/avg-weight/pool blend plus
        -- the small additive novelty boost. The freshness term is applied at
        -- read time in get_river_clusters (shared math in lib/scoring.ts).
        (${SCORE_WEIGHTS.velocity} * velocity_norm)
          + (${SCORE_WEIGHTS.coverage} * coverage_norm)
          + (${SCORE_WEIGHTS.avgWeight} * avg_w_norm)
          + (${SCORE_WEIGHTS.pool} * pool_norm)
          + (${SCORE_WEIGHTS.novelty} * novelty_norm) AS base_score,
        -- cluster freshness, clamped to (0, 1] — for the stored score snapshot.
        ${clusterFreshnessSql("latest_pub")} AS fresh,
        lead_article_id,
        jsonb_build_object(
          'velocity_norm', round(velocity_norm::numeric, 4),
          'coverage_norm', round(coverage_norm::numeric, 4),
          'avg_w_norm', round(avg_w_norm::numeric, 4),
          'pool_norm', round(pool_norm::numeric, 4),
          'novelty_norm', round(novelty_norm::numeric, 4),
          'distinct_sources', distinct_sources,
          'v4', v4
        )::text AS why
      FROM clust_scored
      WHERE lead_article_id IS NOT NULL
    )
    INSERT INTO cluster_scores (cluster_id, size, score, base_score, latest_pub, lead_article_id, why)
    SELECT
      cluster_id,
      size,
      base_score + ${SCORE_WEIGHTS.freshness} * fresh AS score,
      base_score,
      latest_pub,
      lead_article_id,
      why
    FROM final
    ON CONFLICT (cluster_id) DO UPDATE
      SET size = EXCLUDED.size,
          score = EXCLUDED.score,
          base_score = EXCLUDED.base_score,
          latest_pub = EXCLUDED.latest_pub,
          lead_article_id = EXCLUDED.lead_article_id,
          why = EXCLUDED.why,
          updated_at = now();
    `,
    [HL_ARTICLE_H],
  );

  await query(`
    DELETE FROM cluster_scores cs
    WHERE NOT EXISTS (
      SELECT 1
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE ac.cluster_id = cs.cluster_id
        AND ${visibleLanguagePredicate("a")}
    );
  `);

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
        AND ${visibleLanguagePredicate("a")}
      GROUP BY ac.cluster_id
    ),
    embed_stats AS (
      SELECT
        ROUND(100.0 * COUNT(*) FILTER (WHERE embedding IS NOT NULL) / GREATEST(COUNT(*), 1), 1) AS embedded_pct
      FROM articles
      WHERE fetched_at >= now() - interval '7 days'  -- wider than LOOKBACK_DAYS for broader health view
        AND ${visibleLanguagePredicate()}
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
