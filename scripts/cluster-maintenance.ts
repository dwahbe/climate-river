// scripts/cluster-maintenance.ts
// Maintenance script to fix clustering issues:
// 1. Retroactively cluster unclustered articles
// 2. Merge similar clusters that should be together
import { query, endPool } from "@/lib/db";

const SIMILARITY_THRESHOLD = 0.6;

/**
 * Find unclustered articles that have high similarity to existing cluster members
 * and add them to appropriate clusters
 */
async function retroactivelyClusterArticles() {
  console.log("\n📦 Retroactively clustering orphaned articles...");

  // Find unclustered articles with embeddings from the last 7 days
  const { rows: unclustered } = await query<{
    article_id: number;
    title: string;
  }>(
    `
    SELECT a.id as article_id, a.title
    FROM articles a
    LEFT JOIN article_clusters ac ON a.id = ac.article_id
    WHERE ac.article_id IS NULL
      AND a.embedding IS NOT NULL
      AND a.fetched_at >= now() - interval '7 days'
    ORDER BY a.fetched_at DESC
    LIMIT 100
  `,
  );

  console.log(
    `  Found ${unclustered.length} unclustered articles with embeddings`,
  );

  let addedCount = 0;

  for (const article of unclustered) {
    // Find similar articles in existing clusters
    const { rows: matches } = await query<{
      cluster_id: number;
      similarity: number;
      matched_title: string;
    }>(
      `
      SELECT DISTINCT ON (ac.cluster_id)
        ac.cluster_id,
        1 - (a.embedding <=> (SELECT embedding FROM articles WHERE id = $1)) as similarity,
        a.title as matched_title
      FROM articles a
      JOIN article_clusters ac ON a.id = ac.article_id
      WHERE a.id != $1
        AND a.embedding IS NOT NULL
        AND a.fetched_at >= now() - interval '7 days'
        AND 1 - (a.embedding <=> (SELECT embedding FROM articles WHERE id = $1)) > $2
      ORDER BY ac.cluster_id, similarity DESC
      LIMIT 5
    `,
      [article.article_id, SIMILARITY_THRESHOLD],
    );

    if (matches.length > 0) {
      // Pick the cluster with highest similarity
      const bestMatch = matches.sort((a, b) => b.similarity - a.similarity)[0];

      await query(
        `INSERT INTO article_clusters (article_id, cluster_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [article.article_id, bestMatch.cluster_id],
      );

      console.log(
        `  ✓ Added article ${article.article_id} to cluster ${bestMatch.cluster_id} (${(bestMatch.similarity * 100).toFixed(1)}% similar)`,
      );
      console.log(`    "${article.title.slice(0, 60)}..."`);
      console.log(`    matched: "${bestMatch.matched_title.slice(0, 60)}..."`);
      addedCount++;
    }
  }

  console.log(`  Added ${addedCount} articles to existing clusters`);
  return addedCount;
}

/**
 * Find and merge clusters that are about the same story
 * Criteria: >50% of articles in cluster A have >0.6 similarity with articles in cluster B
 */
async function mergeSimilarClusters() {
  console.log("\n🔗 Looking for clusters to merge...");

  // Find cluster pairs with high cross-similarity
  const { rows: clusterPairs } = await query<{
    cluster1: number;
    cluster2: number;
    avg_similarity: number;
    max_similarity: number;
    sample_title1: string;
    sample_title2: string;
  }>(
    `
    WITH cluster_articles AS (
      SELECT 
        ac.cluster_id,
        a.id as article_id,
        a.embedding,
        a.title,
        a.fetched_at
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.embedding IS NOT NULL
        AND a.fetched_at >= now() - interval '7 days'
    ),
    cross_similarity AS (
      SELECT 
        c1.cluster_id as cluster1,
        c2.cluster_id as cluster2,
        1 - (c1.embedding <=> c2.embedding) as similarity,
        c1.title as title1,
        c2.title as title2
      FROM cluster_articles c1
      JOIN cluster_articles c2 ON c1.cluster_id < c2.cluster_id
      WHERE 1 - (c1.embedding <=> c2.embedding) > 0.55
    )
    SELECT 
      cluster1,
      cluster2,
      AVG(similarity) as avg_similarity,
      MAX(similarity) as max_similarity,
      (SELECT title1 FROM cross_similarity cs2 WHERE cs2.cluster1 = cs.cluster1 AND cs2.cluster2 = cs.cluster2 ORDER BY similarity DESC LIMIT 1) as sample_title1,
      (SELECT title2 FROM cross_similarity cs2 WHERE cs2.cluster1 = cs.cluster1 AND cs2.cluster2 = cs.cluster2 ORDER BY similarity DESC LIMIT 1) as sample_title2
    FROM cross_similarity cs
    GROUP BY cluster1, cluster2
    HAVING AVG(similarity) > 0.58 AND COUNT(*) >= 2
    ORDER BY avg_similarity DESC
    LIMIT 20
  `,
  );

  console.log(
    `  Found ${clusterPairs.length} cluster pairs that might need merging`,
  );

  let mergedCount = 0;

  for (const pair of clusterPairs) {
    // Get cluster sizes
    const { rows: sizes } = await query<{
      cluster_id: number;
      size: number;
    }>(
      `
      SELECT ac.cluster_id, COUNT(*) as size
      FROM article_clusters ac
      WHERE ac.cluster_id IN ($1, $2)
      GROUP BY ac.cluster_id
    `,
      [pair.cluster1, pair.cluster2],
    );

    // Merge smaller into larger (or cluster2 into cluster1 if same size)
    const cluster1Size =
      sizes.find((s) => s.cluster_id === pair.cluster1)?.size ?? 0;
    const cluster2Size =
      sizes.find((s) => s.cluster_id === pair.cluster2)?.size ?? 0;

    const [keepCluster, mergeCluster] =
      cluster1Size >= cluster2Size
        ? [pair.cluster1, pair.cluster2]
        : [pair.cluster2, pair.cluster1];

    console.log(
      `\n  Merging cluster ${mergeCluster} (${cluster2Size} articles) into ${keepCluster} (${cluster1Size} articles)`,
    );
    console.log(
      `    Avg similarity: ${(pair.avg_similarity * 100).toFixed(1)}%`,
    );
    console.log(`    "${pair.sample_title1.slice(0, 50)}..."`);
    console.log(`    "${pair.sample_title2.slice(0, 50)}..."`);

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

    // Delete orphaned cluster entries and the merged cluster
    await query("DELETE FROM article_clusters WHERE cluster_id = $1", [
      mergeCluster,
    ]);
    await query("DELETE FROM cluster_scores WHERE cluster_id = $1", [
      mergeCluster,
    ]);
    await query("DELETE FROM clusters WHERE id = $1", [mergeCluster]);

    mergedCount++;
  }

  console.log(`\n  Merged ${mergedCount} cluster pairs`);
  return mergedCount;
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
      0 as score  -- Placeholder; rescore.ts will calculate proper score
    FROM article_clusters ac
    JOIN articles a ON a.id = ac.article_id
    WHERE a.fetched_at >= now() - interval '7 days'
    GROUP BY ac.cluster_id
    ON CONFLICT (cluster_id) DO UPDATE SET
      lead_article_id = EXCLUDED.lead_article_id,
      size = EXCLUDED.size,
      updated_at = NOW()
      -- NOTE: Do NOT update score here - rescore.ts handles that
  `);

  console.log("  ✓ Cluster metadata updated");
}

export async function run(opts: { closePool?: boolean } = {}) {
  console.log("🔧 Cluster Maintenance");
  console.log("═".repeat(50));

  const added = await retroactivelyClusterArticles();
  const merged = await mergeSimilarClusters();

  if (added > 0 || merged > 0) {
    await updateClusterMetadata();
  }

  console.log("\n✅ Cluster maintenance complete!");
  console.log(`  Articles added to clusters: ${added}`);
  console.log(`  Clusters merged: ${merged}`);

  if (opts.closePool) await endPool();
  return { added, merged };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
