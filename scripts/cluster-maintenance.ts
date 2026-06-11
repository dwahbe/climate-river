// scripts/cluster-maintenance.ts
// Maintenance script to fix clustering issues:
// 1. Retroactively cluster unclustered articles (centroid-based)
// 2. Merge similar clusters (centroid-to-centroid comparison)
// 3. Create singleton clusters for remaining orphans
import { query, endPool } from "@/lib/db";
import {
  CLUSTER_CONFIG,
  agglomerativeCluster,
  findBestCluster,
  clusterKey,
  refreshClusterCentroid,
  updateClusterMetadata,
  LEAD_INELIGIBLE_SQL,
} from "@/lib/clustering";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { UNKNOWN_SOURCE_WEIGHT } from "@/config/sourceTiers";

/**
 * Self-healing pass for the persisted centroids (clustering v2): recompute any
 * recently-active cluster whose centroid is missing or older than its newest
 * member. Covers clusters touched by paths that don't refresh incrementally
 * (manual SQL, failed refreshes, pre-v2 rows).
 */
async function refreshStaleCentroids(): Promise<number> {
  console.log("\n🧭 Refreshing stale cluster centroids...");
  const { rows } = await query<{ id: number }>(
    `
    WITH recent AS (
      SELECT DISTINCT ac.cluster_id
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.fetched_at >= now() - make_interval(days => $1)
    )
    UPDATE clusters c
    SET centroid = agg.centroid,
        member_count = agg.member_count,
        last_member_at = agg.last_member_at,
        centroid_updated_at = now()
    FROM (
      SELECT
        ac.cluster_id,
        AVG(a.embedding) FILTER (
          WHERE a.embedding IS NOT NULL AND ${visibleLanguagePredicate("a")}
        ) AS centroid,
        COUNT(*)::int AS member_count,
        MAX(a.fetched_at) AS last_member_at
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE ac.cluster_id IN (SELECT cluster_id FROM recent)
      GROUP BY ac.cluster_id
    ) agg
    WHERE agg.cluster_id = c.id
      AND (
        c.centroid IS NULL
        OR c.centroid_updated_at IS NULL
        OR c.centroid_updated_at < agg.last_member_at
      )
    RETURNING c.id
  `,
    [CLUSTER_CONFIG.LOOKBACK_DAYS],
  );
  console.log(`  Refreshed ${rows.length} centroids`);
  return rows.length;
}

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
  }>(
    `
    SELECT a.id AS article_id, a.title, a.embedding::text AS embedding
    FROM articles a
    LEFT JOIN article_clusters ac ON a.id = ac.article_id
    WHERE ac.article_id IS NULL
      AND a.embedding IS NOT NULL
      AND ${visibleLanguagePredicate("a")}
      AND a.fetched_at >= now() - make_interval(days => $1)
    ORDER BY a.fetched_at DESC
    LIMIT 100
  `,
    [CLUSTER_CONFIG.LOOKBACK_DAYS],
  );

  console.log(
    `  Found ${unclustered.length} unclustered articles with embeddings`,
  );

  let addedCount = 0;

  for (const article of unclustered) {
    const match = await findBestCluster(article.embedding);

    if (match) {
      await query(
        `INSERT INTO article_clusters (article_id, cluster_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [article.article_id, match.clusterId],
      );
      await refreshClusterCentroid(match.clusterId);
      console.log(
        `  ✓ Added article ${article.article_id} to cluster ${match.clusterId} (centroid sim: ${(match.similarity * 100).toFixed(1)}%)`,
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

  // Persisted centroids (clustering v2): candidate pairs come straight from
  // the clusters table — no per-run AVG over every member embedding.
  const { rows: clusterPairs } = await query<{
    cluster1: number;
    cluster2: number;
    centroid_similarity: number;
    size1: number;
    size2: number;
  }>(
    `
    SELECT
      c1.id AS cluster1,
      c2.id AS cluster2,
      1 - (c1.centroid <=> c2.centroid) AS centroid_similarity,
      c1.member_count AS size1,
      c2.member_count AS size2
    FROM clusters c1
    JOIN clusters c2 ON c1.id < c2.id
    WHERE c1.centroid IS NOT NULL AND c2.centroid IS NOT NULL
      AND c1.member_count >= 2 AND c2.member_count >= 2
      AND c1.last_member_at >= now() - make_interval(days => $1)
      AND c2.last_member_at >= now() - make_interval(days => $1)
      AND 1 - (c1.centroid <=> c2.centroid) > $2
      AND c1.member_count + c2.member_count <= $3
    ORDER BY c1.centroid <=> c2.centroid
    LIMIT 10
  `,
    [
      CLUSTER_CONFIG.LOOKBACK_DAYS,
      CLUSTER_CONFIG.MERGE_THRESHOLD,
      CLUSTER_CONFIG.MAX_CLUSTER_SIZE,
    ],
  );

  console.log(
    `  Found ${clusterPairs.length} cluster pairs that might need merging`,
  );

  let mergedCount = 0;

  for (const pair of clusterPairs) {
    // Re-check sizes at merge time: earlier merges in this loop change them,
    // and the pair list's snapshot sizes allowed combined-size overshoot.
    const { rows: current } = await query<{ id: number; member_count: number }>(
      `SELECT id, member_count FROM clusters WHERE id = ANY($1)`,
      [[pair.cluster1, pair.cluster2]],
    );
    if (current.length < 2) continue; // one side already merged away
    const combined = current.reduce((sum, c) => sum + c.member_count, 0);
    if (combined > CLUSTER_CONFIG.MAX_CLUSTER_SIZE) {
      console.log(
        `  ⏭️  Skipping ${pair.cluster1}+${pair.cluster2}: combined size ${combined} exceeds cap after earlier merges`,
      );
      continue;
    }

    // Merge smaller into larger (current sizes, not snapshot sizes)
    const bySize = [...current].sort((a, b) => b.member_count - a.member_count);
    const keepCluster = bySize[0].id;
    const mergeCluster = bySize[1].id;

    console.log(
      `\n  Merging cluster ${mergeCluster} into ${keepCluster} (centroid sim: ${(pair.centroid_similarity * 100).toFixed(1)}%, combined: ${combined})`,
    );

    // Move articles from mergeCluster to keepCluster
    await query(
      `
      UPDATE article_clusters
      SET cluster_id = $1
      WHERE cluster_id = $2
        AND article_id NOT IN (
          SELECT article_id FROM article_clusters WHERE cluster_id = $1
        )
    `,
      [keepCluster, mergeCluster],
    );

    // Clean up merged cluster
    await query("DELETE FROM article_clusters WHERE cluster_id = $1", [
      mergeCluster,
    ]);
    await query("DELETE FROM cluster_scores WHERE cluster_id = $1", [
      mergeCluster,
    ]);
    await query("DELETE FROM clusters WHERE id = $1", [mergeCluster]);

    await refreshClusterCentroid(keepCluster);
    mergedCount++;
  }

  console.log(`\n  Merged ${mergedCount} cluster pairs`);
  return mergedCount;
}

/**
 * Split pass (clustering v2): re-run the tested agglomerative clusterer inside
 * big clusters. A cohesive story re-forms a single group at the join threshold
 * (no-op); a mega-merge falls apart into its real sub-stories, which become
 * new clusters. Self-calibrating — no separate cohesion metric needed.
 */
async function splitOversizedClusters(): Promise<number> {
  console.log("\n✂️  Checking oversized clusters for splits...");

  const { rows: candidates } = await query<{
    id: number;
    member_count: number;
  }>(
    `
    SELECT id, member_count
    FROM clusters
    WHERE member_count >= 20
      AND last_member_at >= now() - make_interval(days => $1)
    ORDER BY member_count DESC
    LIMIT 5
  `,
    [CLUSTER_CONFIG.LOOKBACK_DAYS],
  );

  console.log(`  Found ${candidates.length} split candidates (size ≥ 20)`);

  let splitCount = 0;

  for (const cand of candidates) {
    const { rows: members } = await query<{
      article_id: number;
      embedding: string;
    }>(
      `
      SELECT a.id AS article_id, a.embedding::text AS embedding
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE ac.cluster_id = $1
        AND a.embedding IS NOT NULL
    `,
      [cand.id],
    );
    if (members.length < 4) continue;

    const articles = members.map((m) => ({
      article_id: m.article_id,
      embedding: JSON.parse(m.embedding) as number[],
    }));
    const groups = agglomerativeCluster(
      articles,
      CLUSTER_CONFIG.SIMILARITY_THRESHOLD,
      CLUSTER_CONFIG.MAX_CLUSTER_SIZE,
    );
    if (groups.length < 2) continue;

    // Keep the largest group in place; each remaining group becomes its own
    // cluster (a deterministic key keeps re-runs idempotent).
    const ordered = [...groups].sort((a, b) => b.length - a.length);
    for (const group of ordered.slice(1)) {
      const articleIds = group.map((i) => articles[i].article_id);
      const key = `split-${cand.id}-${Math.min(...articleIds)}`;
      const { rows: created } = await query<{ id: number }>(
        `INSERT INTO clusters (key) VALUES ($1)
         ON CONFLICT (key) DO UPDATE SET key = excluded.key
         RETURNING id`,
        [key],
      );
      const newClusterId = created[0].id;
      await query(
        `UPDATE article_clusters SET cluster_id = $1
         WHERE cluster_id = $2 AND article_id = ANY($3)
           AND article_id NOT IN (
             SELECT article_id FROM article_clusters WHERE cluster_id = $1
           )`,
        [newClusterId, cand.id, articleIds],
      );
      // Drop any leftover memberships (article already in the target cluster).
      await query(
        `DELETE FROM article_clusters
         WHERE cluster_id = $1 AND article_id = ANY($2)`,
        [cand.id, articleIds],
      );
      await refreshClusterCentroid(newClusterId);
      await updateClusterMetadata(newClusterId);
    }
    await refreshClusterCentroid(cand.id);
    await updateClusterMetadata(cand.id);

    console.log(
      `  ✂️  Split cluster ${cand.id} (${members.length} embedded members) into ${groups.length} groups`,
    );
    splitCount++;
  }

  console.log(`  Split ${splitCount} clusters`);
  return splitCount;
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
  }>(
    `
    SELECT a.id as article_id, a.title
    FROM articles a
    LEFT JOIN article_clusters ac ON a.id = ac.article_id
    WHERE ac.article_id IS NULL
      AND a.embedding IS NOT NULL
      AND ${visibleLanguagePredicate("a")}
      AND a.fetched_at >= now() - make_interval(days => $1)
    ORDER BY a.fetched_at DESC
  `,
    [CLUSTER_CONFIG.LOOKBACK_DAYS],
  );

  console.log(`  Found ${orphans.length} orphaned articles`);

  for (const article of orphans) {
    // Key made unique per article (same scheme as assignArticleToCluster) so
    // two UNRELATED articles sharing the same first-8-significant-words can't
    // be silently merged via ON CONFLICT — semantic similarity is the only
    // intended merge path.
    const key = `${clusterKey(article.title) || "semantic"}-${article.article_id}`;

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
    await refreshClusterCentroid(rows[0].id);

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
async function updateAllClusterMetadata() {
  console.log("\n📊 Updating cluster metadata...");

  await query(
    `
    WITH visible_articles AS (
      SELECT
        ac.cluster_id,
        a.id AS article_id,
        a.published_at,
        COALESCE(s.weight, ${UNKNOWN_SOURCE_WEIGHT}) AS source_weight,
        (NOT ${LEAD_INELIGIBLE_SQL})::int AS is_eligible_lead
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.fetched_at >= now() - make_interval(days => $1)
        AND ${visibleLanguagePredicate("a")}
    ),
    ranked AS (
      SELECT
        cluster_id,
        article_id,
        COUNT(*) OVER (PARTITION BY cluster_id)::int AS size,
        ROW_NUMBER() OVER (
          PARTITION BY cluster_id
          ORDER BY is_eligible_lead DESC, source_weight DESC, published_at DESC, article_id DESC
        ) AS lead_rank
      FROM visible_articles
    )
    INSERT INTO cluster_scores (cluster_id, lead_article_id, size, score)
    SELECT cluster_id, article_id, size, 0
    FROM ranked
    WHERE lead_rank = 1
    ON CONFLICT (cluster_id) DO UPDATE SET
      lead_article_id = EXCLUDED.lead_article_id,
      size = EXCLUDED.size,
      updated_at = NOW()
  `,
    [CLUSTER_CONFIG.LOOKBACK_DAYS],
  );

  await query(
    `
    DELETE FROM cluster_scores cs
    WHERE NOT EXISTS (
      SELECT 1
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE ac.cluster_id = cs.cluster_id
        AND ${visibleLanguagePredicate("a")}
    )
  `,
  );

  console.log("  ✓ Cluster metadata updated");
}

export async function run(opts: { closePool?: boolean } = {}) {
  console.log("🔧 Cluster Maintenance");
  console.log("═".repeat(50));

  const refreshed = await refreshStaleCentroids();
  const added = await retroactivelyClusterArticles();
  const merged = await mergeSimilarClusters();
  const splits = await splitOversizedClusters();
  const singletons = await createSingletonClusters();

  if (added > 0 || merged > 0 || splits > 0 || singletons > 0) {
    await updateAllClusterMetadata();
  }

  console.log("\n✅ Cluster maintenance complete!");
  console.log(`  Centroids refreshed: ${refreshed}`);
  console.log(`  Articles added to clusters: ${added}`);
  console.log(`  Clusters merged: ${merged}`);
  console.log(`  Clusters split: ${splits}`);
  console.log(`  Singleton clusters created: ${singletons}`);

  if (opts.closePool) await endPool();
  return { refreshed, added, merged, splits, singletons };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
