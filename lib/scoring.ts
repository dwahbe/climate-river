// lib/scoring.ts
// Single source of truth for the cluster-score blend weights and the
// cluster-freshness decay. Imported by both scripts/rescore.ts (write path)
// and scripts/schema.ts's get_river_clusters (read path) so the stored
// base_score and the serve-time recomputation can never drift apart.

/** Cluster freshness half-life, in hours. */
export const HL_CLUSTER_H = 9;

// Blend weights. velocity/coverage/avgWeight/pool make up the stored,
// decay-free base_score; freshness is applied at read time in
// get_river_clusters against latest_pub. Together they sum to 1.0, so the
// documented shares are the real contribution shares. novelty is a small
// additive boost ON TOP of the unit blend (max +0.03) for clusters
// semantically far from the current top stories.
export const SCORE_WEIGHTS = {
  freshness: 0.51,
  velocity: 0.27,
  coverage: 0.12,
  avgWeight: 0.05,
  pool: 0.05,
  novelty: 0.03,
} as const;

// Novelty ramp: min cosine distance to the trailing top-cluster centroids is
// mapped linearly from FLOOR (0 novelty) to CEIL (full novelty). Calibrated
// against live data 2026-06-11: distances to the nearest top cluster ran
// p10=0.46 / p50=0.60 / p90=0.71, so this ramp spreads clusters across the
// whole [0,1] range instead of saturating (an earlier single 0.45 ceiling put
// 96% of clusters at 1.0, turning the boost into a constant).
export const NOVELTY_DISTANCE_FLOOR = 0.45;
export const NOVELTY_DISTANCE_CEIL = 0.75;

/**
 * SQL for the cluster-freshness term: exponential decay with HL_CLUSTER_H
 * half-life, clamped to (0.0001, 1]. The upper clamp guards against
 * future-dated articles (negative age would otherwise inflate the score).
 */
export function clusterFreshnessSql(latestPubExpr: string): string {
  return `LEAST(1.0, GREATEST(0.0001, EXP(LN(0.5) * LEAST(EXTRACT(EPOCH FROM (now() - ${latestPubExpr})) / (${HL_CLUSTER_H} * 3600.0), 10))))`;
}

/**
 * SQL for the serve-time score: decay-free base plus the freshness term
 * recomputed against latest_pub at read time, so homepage ranking is current
 * at ISR granularity instead of frozen between rescore runs. Falls back to
 * the stored score for pre-migration rows with no latest_pub.
 */
export function serveTimeScoreSql(
  baseScoreExpr: string,
  latestPubExpr: string,
  storedScoreExpr: string,
): string {
  return `CASE
            WHEN ${latestPubExpr} IS NOT NULL THEN
              ${baseScoreExpr} + ${SCORE_WEIGHTS.freshness} * ${clusterFreshnessSql(latestPubExpr)}
            ELSE ${storedScoreExpr}
          END`;
}
