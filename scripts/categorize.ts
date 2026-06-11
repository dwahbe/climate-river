// scripts/categorize.ts
import { query, endPool } from "@/lib/db";
import { categorizeAndStoreArticle } from "@/lib/categorizer";

// Pipeline state machine (categorize stage): every attempt is recorded in
// articles.pipeline_state->'categorize' with {status, attempts, at}. Selection
// stops re-picking articles after MAX_ATTEMPTS errors, and stops re-picking
// 'no_category' articles entirely — UNLESS content was (re)fetched after the
// last attempt, which makes any article eligible again (it may pass the
// climate check with content it didn't have before). This replaces the old
// NULL-column scan that retried the same non-climate articles on every one of
// ~9 runs/day for 30 days, regenerating throwaway embeddings each time.
const MAX_ATTEMPTS = 3;

const CATEGORIZE_STATE_GATE = `
  (
    a.pipeline_state->'categorize' IS NULL
    OR (
      COALESCE((a.pipeline_state#>>'{categorize,attempts}')::int, 0) < ${MAX_ATTEMPTS}
      AND COALESCE(a.pipeline_state#>>'{categorize,status}', '') <> 'no_category'
    )
    OR a.content_fetched_at > COALESCE(
      (a.pipeline_state#>>'{categorize,at}')::timestamptz,
      'epoch'::timestamptz
    )
  )
`;

async function recordCategorizeAttempt(
  articleId: number,
  prevAttempts: number,
  status: "done" | "no_category" | "error",
  error?: string,
): Promise<void> {
  try {
    await query(
      `UPDATE articles
       SET pipeline_state = jsonb_set(
         COALESCE(pipeline_state, '{}'::jsonb),
         '{categorize}',
         $2::jsonb
       )
       WHERE id = $1`,
      [
        articleId,
        JSON.stringify({
          status,
          attempts: prevAttempts + 1,
          at: new Date().toISOString(),
          ...(error ? { last_error: error.slice(0, 200) } : {}),
        }),
      ],
    );
  } catch (stateError) {
    console.warn(
      `  ⚠️  Failed to record categorize state for ${articleId}:`,
      stateError,
    );
  }
}

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
    // Explicit override: ignore the state gate.
    sql = `
      SELECT a.id, a.title, a.dek, a.content_text,
             COALESCE((a.pipeline_state#>>'{categorize,attempts}')::int, 0) AS attempts
      FROM articles a
      WHERE a.published_at >= now() - interval '30 days'
      ORDER BY a.published_at DESC
      LIMIT $1
    `;
  } else if (opts.withContentOnly) {
    // Only retry articles that have content now - avoids wasting API calls
    // on articles that would fail climate check again with just title+dek
    sql = `
      SELECT a.id, a.title, a.dek, a.content_text,
             COALESCE((a.pipeline_state#>>'{categorize,attempts}')::int, 0) AS attempts
      FROM articles a
      LEFT JOIN article_categories ac ON ac.article_id = a.id
      WHERE ac.article_id IS NULL
        AND a.published_at >= now() - interval '30 days'
        AND a.content_status = 'success'
        AND ${CATEGORIZE_STATE_GATE}
      ORDER BY a.published_at DESC
      LIMIT $1
    `;
  } else {
    sql = `
      SELECT a.id, a.title, a.dek, a.content_text,
             COALESCE((a.pipeline_state#>>'{categorize,attempts}')::int, 0) AS attempts
      FROM articles a
      LEFT JOIN article_categories ac ON ac.article_id = a.id
      WHERE ac.article_id IS NULL
        AND a.published_at >= now() - interval '30 days'
        AND ${CATEGORIZE_STATE_GATE}
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
    attempts: number;
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

      const stored = await categorizeAndStoreArticle(
        article.id,
        article.title,
        summary || undefined,
      );
      await recordCategorizeAttempt(
        article.id,
        article.attempts,
        stored > 0 ? "done" : "no_category",
      );
      succeeded++;

      if (processed % 10 === 0) {
        console.log(
          `  ⏳ Progress: ${processed}/${rows.length} (${succeeded} succeeded, ${failed} failed)`,
        );
      }
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await recordCategorizeAttempt(
        article.id,
        article.attempts,
        "error",
        message,
      );
      console.error(
        `  ❌ Failed to categorize article ${article.id}: ${message}`,
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
