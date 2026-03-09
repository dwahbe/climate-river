// scripts/split-mega-clusters.ts
// One-time script to break up oversized clusters using agglomerative re-clustering.
// Usage: bun scripts/split-mega-clusters.ts [--dry-run] [--threshold 25]

import { query, endPool } from "@/lib/db";
import {
  agglomerativeCluster,
  CLUSTER_CONFIG,
} from "@/lib/clustering";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const thresholdIdx = args.indexOf("--threshold");
const sizeThreshold =
  thresholdIdx >= 0 ? parseInt(args[thresholdIdx + 1], 10) : CLUSTER_CONFIG.MAX_CLUSTER_SIZE;

function parseEmbedding(raw: string): number[] {
  if (!raw) return [];
  // pgvector returns "[0.1,0.2,...]" string format
  const cleaned = raw.replace(/^\[|\]$/g, "");
  return cleaned.split(",").map(Number);
}

async function run() {
  console.log(
    `🔪 Split Mega-Clusters (threshold: ${sizeThreshold}, dry-run: ${dryRun})`,
  );
  console.log("═".repeat(50));

  // Find oversized clusters
  const { rows: megaClusters } = await query<{
    cluster_id: number;
    size: number;
    lead_title: string;
  }>(`
    SELECT cs.cluster_id, cs.size,
      (SELECT a.title FROM articles a WHERE a.id = cs.lead_article_id) AS lead_title
    FROM cluster_scores cs
    WHERE cs.size > $1
    ORDER BY cs.size DESC
  `, [sizeThreshold]);

  if (megaClusters.length === 0) {
    console.log("✅ No oversized clusters found.");
    await endPool();
    return;
  }

  console.log(`\nFound ${megaClusters.length} oversized clusters:\n`);
  for (const mc of megaClusters) {
    console.log(`  Cluster ${mc.cluster_id}: ${mc.size} articles — "${mc.lead_title?.slice(0, 70)}..."`);
  }

  let totalSplit = 0;
  let totalNewClusters = 0;
  let totalSingletons = 0;

  for (const mc of megaClusters) {
    console.log(`\n--- Splitting cluster ${mc.cluster_id} (${mc.size} articles) ---`);

    // Fetch all articles with embeddings
    const { rows: articles } = await query<{
      article_id: number;
      title: string;
      embedding: string | null;
    }>(`
      SELECT a.id AS article_id, a.title, a.embedding::text
      FROM article_clusters ac
      JOIN articles a ON ac.article_id = a.id
      WHERE ac.cluster_id = $1
      ORDER BY a.published_at DESC
    `, [mc.cluster_id]);

    // Separate embedded vs non-embedded
    const embedded = articles.filter((a) => a.embedding);
    const noEmbed = articles.filter((a) => !a.embedding);

    console.log(`  ${embedded.length} with embeddings, ${noEmbed.length} without`);

    // Re-cluster embedded articles
    const parsed = embedded.map((a) => ({
      article_id: a.article_id,
      embedding: parseEmbedding(a.embedding!),
    }));

    const subclusters = agglomerativeCluster(
      parsed,
      0.72,
      CLUSTER_CONFIG.MAX_CLUSTER_SIZE,
    );

    console.log(`  → ${subclusters.length} sub-clusters + ${noEmbed.length} singletons`);

    if (dryRun) {
      for (const [i, sc] of subclusters.entries()) {
        const titles = sc.slice(0, 3).map((idx) => `"${embedded[idx].title.slice(0, 60)}..."`);
        console.log(`    Sub-cluster ${i + 1} (${sc.length} articles): ${titles.join(", ")}`);
      }
      totalSplit++;
      totalNewClusters += subclusters.length;
      totalSingletons += noEmbed.length;
      continue;
    }

    // Create new clusters for each sub-cluster
    for (const sc of subclusters) {
      const key = `split-${mc.cluster_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const { rows: newCluster } = await query<{ id: number }>(
        `INSERT INTO clusters (key) VALUES ($1) RETURNING id`,
        [key],
      );
      const newClusterId = newCluster[0].id;

      for (const idx of sc) {
        await query(
          `INSERT INTO article_clusters (article_id, cluster_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [parsed[idx].article_id, newClusterId],
        );
      }

      // Skip cluster_scores — rescore.ts will create entries with proper lead deduplication
      totalNewClusters++;
    }

    // Create singletons for non-embedded articles
    for (const article of noEmbed) {
      const key = `singleton-split-${article.article_id}`;
      const { rows: newCluster } = await query<{ id: number }>(
        `INSERT INTO clusters (key) VALUES ($1) ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
        [key],
      );
      await query(
        `INSERT INTO article_clusters (article_id, cluster_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [article.article_id, newCluster[0].id],
      );
      // Skip cluster_scores — rescore.ts will handle it
      totalSingletons++;
    }

    // Delete old cluster associations and metadata
    await query(`DELETE FROM article_clusters WHERE cluster_id = $1`, [mc.cluster_id]);
    await query(`DELETE FROM cluster_scores WHERE cluster_id = $1`, [mc.cluster_id]);
    await query(`DELETE FROM clusters WHERE id = $1`, [mc.cluster_id]);

    totalSplit++;
    console.log(`  ✓ Cluster ${mc.cluster_id} split into ${subclusters.length} clusters + ${noEmbed.length} singletons`);
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`✅ Split ${totalSplit} mega-clusters`);
  console.log(`   Created ${totalNewClusters} new clusters + ${totalSingletons} singletons`);
  console.log(`\n💡 Run "bun scripts/rescore.ts" to recalculate scores.`);

  await endPool();
}

run().catch((err) => {
  console.error(err);
  endPool().finally(() => process.exit(1));
});
