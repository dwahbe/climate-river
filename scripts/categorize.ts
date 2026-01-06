// scripts/categorize.ts
import { query, endPool } from "@/lib/db";
import { categorizeAndStoreArticle } from "@/lib/categorizer";

export async function run(
  opts: {
    limit?: number;
    closePool?: boolean;
    recategorizeAll?: boolean;
    withContentOnly?: boolean;
  } = {},
) {
  const start = Date.now();
  console.log("🏷️  Starting bulk categorization...");

  // Get all articles that need categorization
  // Either articles with no categories, or all articles if limit is specified
  const limit = opts.limit || 1000; // Default to 1000 articles

  // Build query based on options
  let sql: string;
  if (opts.recategorizeAll) {
    sql = `
      SELECT a.id, a.title, a.dek, a.content_text
      FROM articles a
      WHERE a.published_at >= now() - interval '30 days'
      ORDER BY a.published_at DESC
      LIMIT $1
    `;
  } else if (opts.withContentOnly) {
    // Only retry articles that have content now - avoids wasting API calls
    // on articles that would fail climate check again with just title+dek
    sql = `
      SELECT a.id, a.title, a.dek, a.content_text
      FROM articles a
      LEFT JOIN article_categories ac ON ac.article_id = a.id
      WHERE ac.article_id IS NULL
        AND a.published_at >= now() - interval '30 days'
        AND a.content_status = 'success'
      ORDER BY a.published_at DESC
      LIMIT $1
    `;
  } else {
    sql = `
      SELECT a.id, a.title, a.dek, a.content_text
      FROM articles a
      LEFT JOIN article_categories ac ON ac.article_id = a.id
      WHERE ac.article_id IS NULL
        AND a.published_at >= now() - interval '30 days'
      ORDER BY a.published_at DESC
      LIMIT $1
    `;
  }

  // Include content_text for improved climate relevance checks
  // Articles with prefetched content may pass climate check even if title alone didn't
  const { rows } = await query<{
    id: number;
    title: string;
    dek: string | null;
    content_text: string | null;
  }>(sql, [limit]);

  console.log(
    `📊 Found ${rows.length} articles to ${opts.recategorizeAll ? "re-" : ""}categorize`,
  );

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const article of rows) {
    processed++;

    try {
      // Combine dek and content_text for better categorization
      // This helps articles pass climate check when content has climate terms but title doesn't
      const summary = [article.dek, article.content_text]
        .filter(Boolean)
        .join(" ")
        .slice(0, 2000); // Limit to reasonable length

      await categorizeAndStoreArticle(
        article.id,
        article.title,
        summary || undefined,
      );
      succeeded++;

      if (processed % 10 === 0) {
        console.log(
          `  ⏳ Progress: ${processed}/${rows.length} (${succeeded} succeeded, ${failed} failed)`,
        );
      }
    } catch (error) {
      failed++;
      console.error(
        `  ❌ Failed to categorize article ${article.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const elapsed = Date.now() - start;
  console.log(`\n✅ Bulk categorization complete!`);
  console.log(`📈 Results:`);
  console.log(`   - Processed: ${processed}`);
  console.log(`   - Succeeded: ${succeeded}`);
  console.log(`   - Failed: ${failed}`);
  console.log(`   - Time: ${(elapsed / 1000).toFixed(1)}s`);

  if (opts.closePool) await endPool();
  return { ok: true, processed, succeeded, failed };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  run({ ...cliOpts, closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}

type CliOptions = {
  limit?: number;
  recategorizeAll?: boolean;
  withContentOnly?: boolean;
};

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--limit" || arg === "-l") {
      const next = argv[i + 1];
      if (!next) {
        console.warn("⚠️  --limit flag provided without a value; ignoring");
        continue;
      }
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        opts.limit = Math.max(1, Math.floor(parsed));
      } else {
        console.warn(`⚠️  Invalid --limit value "${next}"; ignoring`);
      }
      i++;
      continue;
    }

    const limitMatch = arg.match(/^--limit=(.+)$/);
    if (limitMatch) {
      const parsed = Number(limitMatch[1]);
      if (Number.isFinite(parsed)) {
        opts.limit = Math.max(1, Math.floor(parsed));
      } else {
        console.warn(`⚠️  Invalid --limit value "${limitMatch[1]}"; ignoring`);
      }
      continue;
    }

    if (arg === "--recategorize-all" || arg === "--recat-all") {
      opts.recategorizeAll = true;
      continue;
    }

    if (arg === "--with-content-only" || arg === "--content-only") {
      opts.withContentOnly = true;
      continue;
    }
  }

  return opts;
}
