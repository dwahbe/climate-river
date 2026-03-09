// scripts/cluster-maintenance.ts
// Maintenance script to fix clustering issues:
// 1. Retroactively cluster unclustered articles (centroid-based)
// 2. Merge similar clusters (centroid-to-centroid comparison)
// 3. Create singleton clusters for remaining orphans
import { query, endPool } from "@/lib/db";
import { CLUSTER_CONFIG } from "@/lib/clustering";

/**
 * Find unclustered articles with embeddings and add them to the best matching
 * cluster based on centroid similarity. Enforces size cap.
 */
async function retroactivelyClusterArticles() {
  console.log("\n📦 Retroactively clustering orphaned articles...");

  const { rows: unclustered } = await query<{
    article_id: number;
    title: string;
    embedding: string;
  }>(`
    SELECT a.id AS article_id, a.title, a.embedding::text AS embedding
    FROM articles a
    LEFT JOIN article_clusters ac ON a.id = ac.article_id
    WHERE ac.article_id IS NULL
      AND a.embedding IS NOT NULL
      AND a.fetched_at >= now() - make_interval(days => $1)
    ORDER BY a.fetched_at DESC
    LIMIT 100
  `, [CLUSTER_CONFIG.LOOKBACK_DAYS]);

  console.log(`  Found ${unclustered.length} unclustered articles with embeddings`);

  let addedCount = 0;

  for (const article of unclustered) {
    // Compare against cluster centroids (not individual members)
    const { rows: matches } = await query<{
      cluster_id: number;
      similarity: number;
      size: number;
    }>(`
      WITH cluster_centroids AS (
        SELECT
          ac.cluster_id,
          COUNT(*)::int AS size,
          AVG(a.embedding) AS centroid
        FROM article_clusters ac
        JOIN articles a ON a.id = ac.article_id
        WHERE a.embedding IS NOT NULL
          AND a.fetched_at >= now() - make_interval(days => $3)
        GROUP BY ac.cluster_id
        HAVING COUNT(*) < $2
      )
      SELECT
        cluster_id,
        1 - (centroid <=> $1::vector) AS similarity,
        size
      FROM cluster_centroids
      WHERE 1 - (centroid <=> $1::vector) > $4
      ORDER BY centroid <=> $1::vector
      LIMIT 1
    `, [
      article.embedding,
      CLUSTER_CONFIG.MAX_CLUSTER_SIZE,
      CLUSTER_CONFIG.LOOKBACK_DAYS,
      CLUSTER_CONFIG.SIMILARITY_THRESHOLD,
    ]);

    if (matches.length > 0) {
      const best = matches[0];
      await query(
        `INSERT INTO article_clusters (article_id, cluster_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [article.article_id, best.cluster_id],
      );
      console.log(
        `  ✓ Added article ${article.article_id} to cluster ${best.cluster_id} (centroid sim: ${(best.similarity * 100).toFixed(1)}%)`,
      );
      console.log(`    "${article.title.slice(0, 60)}..."`);
      addedCount++;
    }
  }

  console.log(`  Added ${addedCount} articles to existing clusters`);
  return addedCount;
}

/**
 * Find and merge clusters with similar centroids.
 * Uses centroid-to-centroid comparison instead of pairwise article comparison.
 * Enforces combined size cap.
 */
async function mergeSimilarClusters() {
  console.log("\n🔗 Looking for clusters to merge...");

  const { rows: clusterPairs } = await query<{
    cluster1: number;
    cluster2: number;
    centroid_similarity: number;
    size1: number;
    size2: number;
  }>(`
    WITH cluster_centroids AS (
      SELECT
        ac.cluster_id,
        COUNT(*)::int AS size,
        AVG(a.embedding) AS centroid
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.embedding IS NOT NULL
        AND a.fetched_at >= now() - make_interval(days => $1)
      GROUP BY ac.cluster_id
      HAVING COUNT(*) >= 2
    )
    SELECT
      c1.cluster_id AS cluster1,
      c2.cluster_id AS cluster2,
      1 - (c1.centroid <=> c2.centroid) AS centroid_similarity,
      c1.size AS size1,
      c2.size AS size2
    FROM cluster_centroids c1
    JOIN cluster_centroids c2 ON c1.cluster_id < c2.cluster_id
    WHERE 1 - (c1.centroid <=> c2.centroid) > $2
      AND c1.size + c2.size <= $3
    ORDER BY c1.centroid <=> c2.centroid
    LIMIT 10
  `, [
    CLUSTER_CONFIG.LOOKBACK_DAYS,
    CLUSTER_CONFIG.MERGE_THRESHOLD,
    CLUSTER_CONFIG.MAX_CLUSTER_SIZE,
  ]);

  console.log(`  Found ${clusterPairs.length} cluster pairs that might need merging`);

  let mergedCount = 0;

  for (const pair of clusterPairs) {
    // Merge smaller into larger
    const [keepCluster, mergeCluster] =
      pair.size1 >= pair.size2
        ? [pair.cluster1, pair.cluster2]
        : [pair.cluster2, pair.cluster1];

    console.log(
      `\n  Merging cluster ${mergeCluster} into ${keepCluster} (centroid sim: ${(pair.centroid_similarity * 100).toFixed(1)}%, combined: ${pair.size1 + pair.size2})`,
    );

    // Move articles from mergeCluster to keepCluster
    await query(`
      UPDATE article_clusters
      SET cluster_id = $1
      WHERE cluster_id = $2
        AND article_id NOT IN (
          SELECT article_id FROM article_clusters WHERE cluster_id = $1
        )
    `, [keepCluster, mergeCluster]);

    // Clean up merged cluster
    await query("DELETE FROM article_clusters WHERE cluster_id = $1", [mergeCluster]);
    await query("DELETE FROM cluster_scores WHERE cluster_id = $1", [mergeCluster]);
    await query("DELETE FROM clusters WHERE id = $1", [mergeCluster]);

    mergedCount++;
  }

  console.log(`\n  Merged ${mergedCount} cluster pairs`);
  return mergedCount;
}

/**
 * Create singleton clusters for articles that are still unclustered
 * after retroactive clustering. Ensures every article enters the display pipeline.
 */
async function createSingletonClusters() {
  console.log("\n🫧 Creating singleton clusters for remaining orphans...");

  const { rows: orphans } = await query<{
    article_id: number;
    title: string;
  }>(`
    SELECT a.id as article_id, a.title
    FROM articles a
    LEFT JOIN article_clusters ac ON a.id = ac.article_id
    WHERE ac.article_id IS NULL
      AND a.embedding IS NOT NULL
      AND a.fetched_at >= now() - make_interval(days => $1)
    ORDER BY a.fetched_at DESC
  `, [CLUSTER_CONFIG.LOOKBACK_DAYS]);

  console.log(`  Found ${orphans.length} orphaned articles`);

  for (const article of orphans) {
    const key =
      article.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .join("-") || `singleton-${Date.now()}`;

    const { rows } = await query<{ id: number }>(
      `INSERT INTO clusters (key) VALUES ($1)
       ON CONFLICT (key) DO UPDATE SET key = excluded.key
       RETURNING id`,
      [key],
    );

    await query(
      `INSERT INTO article_clusters (article_id, cluster_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [article.article_id, rows[0].id],
    );

    console.log(
      `  ✓ Singleton cluster ${rows[0].id} for article ${article.article_id}: "${article.title.slice(0, 60)}..."`,
    );
  }

  console.log(`  Created ${orphans.length} singleton clusters`);
  return orphans.length;
}

/**
 * Update cluster metadata (lead article, size) after maintenance.
 * NOTE: Does NOT update score - that's handled by rescore.ts which has the
 * proper scoring algorithm. We only update lead_article_id and size here.
 */
async function updateClusterMetadata() {
  console.log("\n📊 Updating cluster metadata...");

  await query(`
    INSERT INTO cluster_scores (cluster_id, lead_article_id, size, score)
    SELECT
      ac.cluster_id,
      (SELECT a.id
       FROM articles a
       JOIN article_clusters ac2 ON ac2.article_id = a.id
       WHERE ac2.cluster_id = ac.cluster_id
       ORDER BY a.published_at DESC, a.id DESC
       LIMIT 1) as lead_article_id,
      COUNT(*) as size,
      0 as score
    FROM article_clusters ac
    JOIN articles a ON a.id = ac.article_id
    WHERE a.fetched_at >= now() - make_interval(days => $1)
    GROUP BY ac.cluster_id
    ON CONFLICT (cluster_id) DO UPDATE SET
      lead_article_id = EXCLUDED.lead_article_id,
      size = EXCLUDED.size,
      updated_at = NOW()
  `, [CLUSTER_CONFIG.LOOKBACK_DAYS]);

  console.log("  ✓ Cluster metadata updated");
}

export async function run(opts: { closePool?: boolean } = {}) {
  console.log("🔧 Cluster Maintenance");
  console.log("═".repeat(50));

  const added = await retroactivelyClusterArticles();
  const merged = await mergeSimilarClusters();
  const singletons = await createSingletonClusters();

  if (added > 0 || merged > 0 || singletons > 0) {
    await updateClusterMetadata();
  }

  console.log("\n✅ Cluster maintenance complete!");
  console.log(`  Articles added to clusters: ${added}`);
  console.log(`  Clusters merged: ${merged}`);
  console.log(`  Singleton clusters created: ${singletons}`);

  if (opts.closePool) await endPool();
  return { added, merged, singletons };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
