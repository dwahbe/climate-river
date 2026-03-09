// scripts/backfill-embeddings.ts
// One-time script to generate embeddings for articles that don't have them.
// Usage: bun scripts/backfill-embeddings.ts [--limit 500] [--days 14] [--dry-run]

import { query, endPool } from "@/lib/db";
import { generateEmbedding } from "@/lib/clustering";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 200;
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 14;

async function run() {
  console.log(`📦 Backfill Embeddings (limit: ${limit}, days: ${days}, dry-run: ${dryRun})`);
  console.log("═".repeat(50));

  // Count articles missing embeddings
  const { rows: [stats] } = await query<{
    missing: number;
    total: number;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE embedding IS NULL) AS missing,
      COUNT(*) AS total
    FROM articles
    WHERE fetched_at >= now() - make_interval(days => $1)
  `, [days]);

  console.log(`\n  ${stats.missing} of ${stats.total} recent articles (${days}d) missing embeddings`);

  if (stats.missing === 0) {
    console.log("✅ All recent articles have embeddings.");
    await endPool();
    return;
  }

  // Fetch articles to backfill
  const { rows: articles } = await query<{
    id: number;
    title: string;
    dek: string | null;
  }>(`
    SELECT id, title, dek
    FROM articles
    WHERE embedding IS NULL
      AND fetched_at >= now() - make_interval(days => $1)
    ORDER BY published_at DESC
    LIMIT $2
  `, [days, limit]);

  console.log(`  Processing ${articles.length} articles...\n`);

  if (dryRun) {
    for (const a of articles.slice(0, 10)) {
      console.log(`  [dry-run] Would embed: "${a.title.slice(0, 70)}..."`);
    }
    if (articles.length > 10) console.log(`  ... and ${articles.length - 10} more`);
    await endPool();
    return;
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    try {
      const embedding = await generateEmbedding(article.title, article.dek ?? undefined);
      if (embedding.length > 0) {
        await query(
          `UPDATE articles SET embedding = $1 WHERE id = $2`,
          [JSON.stringify(embedding), article.id],
        );
        success++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ Article ${article.id}: ${err}`);
      failed++;
    }

    // Rate limit: ~3/sec to stay well under OpenAI's limits
    if ((i + 1) % 3 === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Progress logging
    if ((i + 1) % 50 === 0) {
      console.log(`  Progress: ${i + 1}/${articles.length} (${success} ok, ${failed} failed)`);
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`✅ Backfill complete: ${success} embedded, ${failed} failed`);
  console.log(`   Remaining: ${stats.missing - success} articles still missing embeddings`);
  console.log(`\n💡 Run "bun scripts/cluster-maintenance.ts" to cluster newly-embedded articles.`);

  await endPool();
}

run().catch((err) => {
  console.error(err);
  endPool().finally(() => process.exit(1));
});
