// scripts/cleanup.ts
// Delete articles older than RETENTION_DAYS to keep Supabase data usage in check.
// Cascade deletes handle article_clusters, article_categories, and cluster_scores.
// Orphaned clusters (with no remaining articles) are cleaned up afterward.

import { query, endPool } from "@/lib/db";

const DEFAULT_RETENTION_DAYS = 60;

interface CleanupResult {
  ok: true;
  retentionDays: number;
  dryRun: boolean;
  articlesDeleted: number;
  orphanedClustersDeleted: number;
  articlesBefore: number;
  articlesAfter: number;
}

/**
 * Delete articles older than `retentionDays` and clean up orphaned clusters.
 *
 * Uses COALESCE(published_at, fetched_at) so articles with a missing
 * published_at still get cleaned up based on when they were fetched.
 */
export async function run(
  opts: {
    retentionDays?: number;
    dryRun?: boolean;
    closePool?: boolean;
  } = {},
): Promise<CleanupResult> {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const dryRun = opts.dryRun ?? false;

  console.log("🧹 Article Cleanup");
  console.log("═".repeat(50));
  console.log(`  Retention: ${retentionDays} days`);
  console.log(`  Mode:      ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`);

  // --- Stats before ---
  const { rows: beforeRows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM articles`,
  );
  const articlesBefore = beforeRows[0].count;

  // --- Find stale articles ---
  const { rows: staleRows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM articles
     WHERE coalesce(published_at, fetched_at) < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  const staleCount = staleRows[0].count;
  console.log(
    `\n  Total articles:     ${articlesBefore.toLocaleString()}`,
  );
  console.log(
    `  Articles > ${retentionDays}d old: ${staleCount.toLocaleString()}`,
  );

  let articlesDeleted = 0;
  let orphanedClustersDeleted = 0;

  if (staleCount === 0) {
    console.log("\n  Nothing to clean up.");
  } else if (dryRun) {
    console.log("\n  Dry run — skipping deletes.");
    articlesDeleted = staleCount; // report what *would* be deleted
  } else {
    // --- Delete stale articles (cascades handle junction rows) ---
    const { rowCount } = await query(
      `DELETE FROM articles
       WHERE coalesce(published_at, fetched_at) < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    articlesDeleted = rowCount;
    console.log(`\n  🗑️  Deleted ${articlesDeleted.toLocaleString()} articles`);

    // --- Clean up orphaned clusters ---
    const { rowCount: orphanedScores } = await query(
      `DELETE FROM cluster_scores
       WHERE cluster_id NOT IN (SELECT DISTINCT cluster_id FROM article_clusters)`,
    );
    if (orphanedScores > 0) {
      console.log(`  🗑️  Deleted ${orphanedScores} orphaned cluster_scores`);
    }

    const { rowCount: orphanedClusters } = await query(
      `DELETE FROM clusters
       WHERE id NOT IN (SELECT DISTINCT cluster_id FROM article_clusters)`,
    );
    orphanedClustersDeleted = orphanedClusters;
    if (orphanedClusters > 0) {
      console.log(`  🗑️  Deleted ${orphanedClusters} orphaned clusters`);
    }
  }

  // --- Stats after ---
  const { rows: afterRows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM articles`,
  );
  const articlesAfter = afterRows[0].count;

  console.log(`\n  Articles remaining: ${articlesAfter.toLocaleString()}`);
  console.log("✅ Cleanup complete!");

  if (opts.closePool) await endPool();

  return {
    ok: true,
    retentionDays,
    dryRun,
    articlesDeleted,
    orphanedClustersDeleted,
    articlesBefore,
    articlesAfter,
  };
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const daysFlag = process.argv.find((a) => a.startsWith("--days="));
  const retentionDays = daysFlag
    ? Number(daysFlag.split("=")[1])
    : DEFAULT_RETENTION_DAYS;

  run({ retentionDays, dryRun, closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
