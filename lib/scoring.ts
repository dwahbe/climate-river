// lib/scoring.ts
// Single source of truth for the cluster-score blend weights and the
// cluster-freshness decay. Imported by both scripts/rescore.ts (write path)
// and scripts/schema.ts's get_river_clusters (read path) so the stored
// base_score and the serve-time recomputation can never drift apart.
import {
  JOURNAL_URL_SQL_REGEX,
  JOURNAL_WEIGHT_CAP,
  UNKNOWN_SOURCE_WEIGHT,
} from "@/config/sourceTiers";

/** Cluster freshness half-life, in hours (9 → 12 on 2026-08-21: with velocity
 * carrying the "is this being covered" signal, freshness can decay slower). */
export const HL_CLUSTER_H = 12;

/**
 * Velocity window, in hours. Velocity = Σ (distinct-source weight / 10) over
 * members published in this window. Was 4h — with a pipeline that runs a few
 * times a day, a 4h window meant a brand-new singleton always out-scored a
 * six-article, three-outlet story from earlier the same day (its velocity
 * read 0). 24h measures "is this being covered today", the Techmeme signal.
 */
export const VELOCITY_WINDOW_H = 24;

// Blend weights. velocity/coverage/authority/pool make up the stored,
// decay-free base_score; freshness is applied at read time in
// get_river_clusters against latest_pub. Together they sum to 1.0, so the
// documented shares are the real contribution shares. novelty is a small
// additive boost ON TOP of the unit blend (max +0.03) for clusters
// semantically far from the current top stories.
//
// Rebalanced 2026-08-21 (Techmeme-style Top feed), validated against the live
// candidate pool with tmp/sim-ranking.ts: freshness 0.51→0.30 so a brand-new
// singleton no longer outranks a corroborated story from earlier in the day;
// velocity 0.27→0.35 and now trust-weighted over a 24h window (sum of
// distinct-source weights/10, not a raw 4h source count); authority (best
// source covering the story, replacing the member average that low-weight
// corroborators dragged down) 0.05→0.15.
export const SCORE_WEIGHTS = {
  freshness: 0.3,
  velocity: 0.35,
  coverage: 0.15,
  authority: 0.15,
  pool: 0.05,
  novelty: 0.03,
} as const;

// Age damping (read-time multiplier, also applied to the stored score): a
// cluster whose FIRST article is days old can't hold the top slot on a trickle
// of new members — "Europe's scorching summer" sat at #1 for two weeks because
// every new member refreshed latest_pub. Gentle half-life on cluster age with
// a floor, so old-but-active stories are discounted, not hidden. (A 96h/0.5
// first cut pushed every multi-day story out of the Top-20 entirely.)
export const AGE_DAMPING_HL_H = 168;
export const AGE_DAMPING_FLOOR = 0.7;

// Singleton discount (homepage/category ordering only, never hides): even
// with freshness at 30% a 1-hour-old top-tier singleton can outrun a 4-hour-old
// story carried by three outlets. Corroboration is the Techmeme signal, so
// uncorroborated clusters (strong_sources < minStrongSources) get a flat
// discount in score ordering.
export const SINGLETON_DISCOUNT = 0.85;

// Top-feed eligibility gate (homepage Top only; Latest and category views are
// ungated): a cluster needs corroboration from ≥2 "strong" sources (weight ≥
// strongSourceMinWeight) OR a lead from a top-tier source (weight ≥
// minLeadWeight). Stops content-farm / trade-press singletons from leading
// Top while keeping a lone FT/Nature/Grist scoop.
export const TOP_GATE = {
  minStrongSources: 2,
  strongSourceMinWeight: 4,
  minLeadWeight: 8,
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

/**
 * SQL for the age-damping multiplier: half-life decay (AGE_DAMPING_HL_H) on
 * the cluster's first publication time, floored at AGE_DAMPING_FLOOR and
 * clamped to ≤ 1. NULL first_pub (pre-migration rows) → 1.0 (no damping).
 */
export function clusterAgeDampingSql(firstPubExpr: string): string {
  return `CASE
            WHEN ${firstPubExpr} IS NULL THEN 1.0
            ELSE GREATEST(${AGE_DAMPING_FLOOR}, LEAST(1.0, EXP(LN(0.5) * LEAST(EXTRACT(EPOCH FROM (now() - ${firstPubExpr})) / (${AGE_DAMPING_HL_H} * 3600.0), 20))))
          END`;
}

/**
 * SQL for the homepage Top gate. Expects expressions for the cluster's strong
 * source count and lead source weight; true when the cluster may appear in Top.
 */
export function topGateSql(
  strongSourcesExpr: string,
  leadWeightExpr: string,
): string {
  return `(COALESCE(${strongSourcesExpr}, ${TOP_GATE.minStrongSources}) >= ${TOP_GATE.minStrongSources}
           OR COALESCE(${leadWeightExpr}, 0) >= ${TOP_GATE.minLeadWeight})`;
}

/**
 * SQL for the singleton discount multiplier (score ordering only). NULL or
 * unknown strong-source counts are treated as corroborated (no discount).
 */
export function singletonDiscountSql(strongSourcesExpr: string): string {
  return `CASE
            WHEN COALESCE(${strongSourcesExpr}, ${TOP_GATE.minStrongSources}) < ${TOP_GATE.minStrongSources} THEN ${SINGLETON_DISCOUNT}
            ELSE 1.0
          END`;
}

/**
 * SQL for an article's normalized publisher host from its canonical URL
 * (scheme/port stripped, common www/m/amp/news/edition prefixes removed).
 * Corroboration must count OUTLETS, not `sources` rows — the table holds
 * several rows per outlet (RSS + discover:// + web://), so grouping by
 * source_id let one outlet corroborate itself.
 */
export function publisherHostSql(urlExpr: string): string {
  return `lower(regexp_replace(split_part(split_part(split_part(${urlExpr}, '://', 2), '/', 1), ':', 1), '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\.', ''))`;
}

/**
 * SQL for an article's effective source weight: the source row's weight
 * (UNKNOWN_SOURCE_WEIGHT when missing), capped for journal-paper URLs so a
 * paper is never a top-tier lead regardless of which source row it attached
 * to (config/sourceTiers.ts JOURNAL_*).
 */
export function sourceWeightSql(weightExpr: string, urlExpr: string): string {
  return `CASE
            WHEN ${urlExpr} ~* '${JOURNAL_URL_SQL_REGEX}' THEN LEAST(COALESCE(${weightExpr}, ${UNKNOWN_SOURCE_WEIGHT}), ${JOURNAL_WEIGHT_CAP})
            ELSE COALESCE(${weightExpr}, ${UNKNOWN_SOURCE_WEIGHT})
          END`;
}

/**
 * SQL aggregate for the Top gate's "strong source" count: distinct publisher
 * hosts whose effective weight clears TOP_GATE.strongSourceMinWeight. Used by
 * rescore (write) and the get_river_clusters fallback (read) so the two can't
 * disagree on who counts.
 */
export function strongSourceCountSql(
  hostExpr: string,
  weightExpr: string,
): string {
  return `COUNT(DISTINCT ${hostExpr}) FILTER (WHERE COALESCE(${weightExpr}, ${UNKNOWN_SOURCE_WEIGHT}) >= ${TOP_GATE.strongSourceMinWeight})`;
}
