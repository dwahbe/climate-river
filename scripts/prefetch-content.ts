// scripts/prefetch-content.ts
import { query, endPool } from "@/lib/db";
import { prefetchArticles } from "@/lib/services/readerService";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { PAYWALL_URL_SQL_REGEX } from "@/lib/paywalls";
import { AGGREGATOR_URL_SQL_REGEX } from "@/lib/aggregators";

type PrefetchOptions = {
  limit?: number;
  closePool?: boolean;
  // Recent window: only consider articles fetched within the last N hours
  hoursAgo?: number;
  // Catchup window: after the recent batch, also retry NULL-status articles
  // up to this many days old that fell out of prior `hoursAgo` windows.
  // Default 0 means catchup disabled (no regression vs prior behavior).
  catchupDays?: number;
  // Stop scheduling new fetches after this many milliseconds.
  deadlineMs?: number;
  // Absolute wall-clock deadline. Takes precedence over deadlineMs.
  deadlineAt?: number;
};

// Derived from the shared domain lists so the pipeline never burns fetches
// on articles the reader UI will refuse to show (lib/paywalls.ts) or on
// aggregator interstitials that extract as "0 words" (lib/aggregators.ts).
const PAYWALL_FILTER = `
  canonical_url !~* '${PAYWALL_URL_SQL_REGEX}'
  AND canonical_url !~* '${AGGREGATOR_URL_SQL_REGEX}'
`;

const LANGUAGE_FILTER = visibleLanguagePredicate();

/**
 * Prefetch article content for recently ingested articles.
 *
 * Two-phase selection (when catchupDays > 0):
 *   1. Recent: articles fetched within `hoursAgo` with content_status NULL/error
 *   2. Catchup: NULL-status articles older than the recent window but within
 *      catchupDays — picks up articles that fell out of prior prefetch windows
 *      before any retry ran.
 */
export async function run(opts: PrefetchOptions = {}) {
  const startTime = Date.now();
  const limit = opts.limit ?? 50;
  const hoursAgo = opts.hoursAgo ?? 24;
  const catchupDays = Math.max(0, opts.catchupDays ?? 0);
  const deadlineAt =
    opts.deadlineAt ??
    (opts.deadlineMs ? Date.now() + opts.deadlineMs : undefined);

  const windowDesc =
    catchupDays > 0
      ? `last ${hoursAgo}h + catchup to ${catchupDays}d for never-attempted`
      : `last ${hoursAgo}h`;
  console.log(
    `🔄 Prefetching content for up to ${limit} articles (${windowDesc})...`,
  );

  try {
    // Phase 1: recent window — picks up NULL or error status
    const { rows: recentRows } = await query<{ id: number; title: string }>(
      `
      SELECT id, title
      FROM articles
      WHERE fetched_at >= NOW() - INTERVAL '1 hour' * $1
        AND (content_status IS NULL OR content_status = 'error')
        AND ${LANGUAGE_FILTER}
        AND ${PAYWALL_FILTER}
      ORDER BY published_at DESC NULLS LAST, fetched_at DESC
      LIMIT $2
    `,
      [hoursAgo, limit],
    );

    // Phase 2: catchup — only NULL-status articles older than the recent
    // window but within the catchup window. Errors past 24h are not retried
    // (likely permanent extraction failures).
    let catchupRows: Array<{ id: number; title: string }> = [];
    const remaining = limit - recentRows.length;
    if (catchupDays > 0 && remaining > 0) {
      const result = await query<{ id: number; title: string }>(
        `
        SELECT id, title
        FROM articles
        WHERE fetched_at < NOW() - INTERVAL '1 hour' * $1
          AND fetched_at >= NOW() - INTERVAL '1 day' * $2
          AND content_status IS NULL
          AND ${LANGUAGE_FILTER}
          AND ${PAYWALL_FILTER}
        ORDER BY fetched_at DESC
        LIMIT $3
      `,
        [hoursAgo, catchupDays, remaining],
      );
      catchupRows = result.rows;
    }

    const rows = [...recentRows, ...catchupRows];

    if (rows.length === 0) {
      console.log("✨ No articles need prefetching");
      if (opts.closePool) await endPool();
      return {
        total: 0,
        recent: 0,
        catchup: 0,
        scheduled: 0,
        skipped: 0,
        duration: Math.round((Date.now() - startTime) / 1000),
      };
    }

    if (catchupRows.length > 0) {
      console.log(
        `📖 Found ${rows.length} articles to prefetch (${recentRows.length} recent + ${catchupRows.length} catchup)`,
      );
    } else {
      console.log(`📖 Found ${rows.length} articles to prefetch`);
    }

    // Prefetch with concurrency of 3 (balance between speed and politeness)
    const prefetchStats = await prefetchArticles(
      rows.map((r) => r.id),
      3,
      { deadlineAt },
    );

    // Check results
    const { rows: results } = await query<{
      content_status: string;
      count: number;
    }>(
      `
      SELECT
        COALESCE(content_status, 'pending') as content_status,
        COUNT(*) as count
      FROM articles
      WHERE id = ANY($1)
      GROUP BY content_status
    `,
      [rows.map((r) => r.id)],
    );

    const stats: Record<string, number> = {};
    for (const r of results) {
      stats[r.content_status] = Number(r.count);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ Prefetch completed in ${duration}s:`, stats);

    if (opts.closePool) await endPool();

    return {
      total: rows.length,
      recent: recentRows.length,
      catchup: catchupRows.length,
      scheduled: prefetchStats.scheduled,
      skipped: prefetchStats.skipped,
      stats,
      duration,
    };
  } catch (error) {
    console.error("❌ Prefetch failed:", error);
    if (opts.closePool) await endPool();
    throw error;
  }
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
