// app/api/cron/full/route.ts
// Full pipeline cron - runs 3×/day for comprehensive processing
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for comprehensive job

import { NextResponse } from "next/server";
import { authorized, safeRun, logPipelineRun } from "@/lib/cron";

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const t0 = Date.now();
  const url = new URL(req.url);
  const timeoutMs = 280_000; // Leave 20s buffer before 5min timeout

  // Helper to check remaining time
  const hasTime = () => Date.now() - t0 < timeoutMs;
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  // Conservative limits to fit within 5min
  const discoverLimit = Math.max(
    1,
    Math.min(60, Number(url.searchParams.get("discover") || 40)),
  );
  const ingestLimit = Math.max(
    1,
    Math.min(100, Number(url.searchParams.get("limit") || 60)),
  );

  try {
    console.log("🎯 Full cron job starting...");

    // 1) Feed discovery - fast (deadline bounds GN URL resolutions)
    console.log("📡 Running discover...");
    const discoverResult = await safeRun(import("@/scripts/discover"), {
      limit: discoverLimit,
      deadlineMs: 75_000,
      closePool: false,
    });
    console.log(`✅ Discover completed (${elapsed()}s):`, discoverResult);

    // 2) Ingest articles - moderate
    console.log("📥 Running ingest...");
    const ingestResult = await safeRun(import("@/scripts/ingest"), {
      limit: ingestLimit,
      closePool: false,
    });
    console.log(`✅ Ingest completed (${elapsed()}s):`, ingestResult);

    // 3) Categorize - moderate (AI calls)
    console.log("🏷️  Running categorize...");
    const categorizeResult = await safeRun(import("@/scripts/categorize"), {
      limit: 40,
      closePool: false,
    });
    console.log(`✅ Categorize completed (${elapsed()}s):`, categorizeResult);

    // 4) Prefetch content - fast. Includes a catchup pass for NULL-status
    // articles up to 7 days old that missed prior windows (especially common
    // for web-discovered articles inserted late in a refresh cycle).
    console.log("📖 Prefetching article content...");
    const prefetchResult = await safeRun(import("@/scripts/prefetch-content"), {
      limit: 60,
      catchupDays: 7,
      deadlineMs: 70_000,
      closePool: false,
    });
    console.log(`✅ Prefetch completed (${elapsed()}s):`, prefetchResult);

    // 4b) Re-categorize after prefetch - catches articles with content that failed initial categorization
    // Only retry articles that now have content (content_status='success')
    console.log("🏷️  Re-categorizing articles with new content...");
    const recategorizeResult = await safeRun(import("@/scripts/categorize"), {
      limit: 30,
      withContentOnly: true,
      closePool: false,
    });
    console.log(
      `✅ Re-categorize completed (${elapsed()}s):`,
      recategorizeResult,
    );

    // 5) Cluster maintenance - fix orphaned articles and merge similar clusters
    let clusterMaintenanceResult: unknown = { skipped: "timeout" };
    if (hasTime()) {
      console.log("🔧 Running cluster maintenance...");
      clusterMaintenanceResult = await safeRun(
        import("@/scripts/cluster-maintenance"),
        {
          closePool: false,
        },
      );
      console.log(
        `✅ Cluster maintenance completed (${elapsed()}s):`,
        clusterMaintenanceResult,
      );
    }

    // 6) WEB DISCOVERY
    let webDiscoverResult: unknown = { skipped: "timeout" };
    let prefetchDiscoveredResult: unknown = { skipped: "not_run" };

    if (hasTime()) {
      try {
        console.log(`🔎 Running AI web discovery (${elapsed()}s elapsed)...`);
        webDiscoverResult = await safeRun(import("@/scripts/discover-web"), {
          broadArticleCap: 10,
          outletArticleCap: 20,
          outletLimitPerBatch: 6,
          outletBatchSize: 3,
          outletFreshHours: 72,
          // Leave ≥60s for discovered-prefetch + rescore + inline rewrite.
          deadlineAt: t0 + timeoutMs - 60_000,
          closePool: false,
        });
        console.log(`✅ AI web discovery completed (${elapsed()}s)`);

        // Prefetch discovered articles
        if (hasTime()) {
          console.log("📖 Prefetching discovered articles...");
          prefetchDiscoveredResult = await safeRun(
            import("@/scripts/prefetch-content"),
            {
              limit: 15,
              hoursAgo: 6,
              deadlineMs: 35_000,
              closePool: false,
            },
          );
          console.log(`✅ Discovered prefetch completed (${elapsed()}s)`);
        }
      } catch (webErr: unknown) {
        console.error("❌ AI web discovery failed:", webErr);
        const msg = webErr instanceof Error ? webErr.message : String(webErr);
        webDiscoverResult = { error: msg, skipped: "error" };
      }
    } else {
      console.log(
        `⏭️  Skipping web discovery (${elapsed()}s elapsed, timeout risk)`,
      );
    }

    // 7) Rescore clusters LAST so it scores everything maintenance merged and
    // web discovery just created — otherwise new/merged clusters sit at score 0
    // (their interim metadata score) until the next run, up to 6h later.
    console.log("🔢 Running rescore...");
    const rescoreResult = await safeRun(import("@/scripts/rescore"), {
      closePool: false,
    });
    console.log(`✅ Rescore completed (${elapsed()}s):`, rescoreResult);

    // 8) Rewrite-at-ingest: rescore just elected leads for newly discovered /
    // merged clusters — rewrite them now (deadline-aware) instead of waiting up
    // to an hour for the rewrite cron, which becomes a sweeper.
    let inlineRewriteResult: unknown = { skipped: "timeout" };
    {
      const remainingMs = t0 + timeoutMs - Date.now();
      if (remainingMs > 20_000) {
        console.log("✏️  Inline rewrite of fresh leads...");
        inlineRewriteResult = await safeRun(import("@/scripts/rewrite"), {
          limit: 25,
          deadlineMs: remainingMs - 10_000,
          closePool: false,
        });
        console.log(
          `✅ Inline rewrite completed (${elapsed()}s):`,
          inlineRewriteResult,
        );
      }
    }

    console.log(`🎯 Full cron job completed in ${elapsed()}s!`);

    const result = {
      discover: discoverResult,
      ingest: ingestResult,
      categorize: categorizeResult,
      prefetch: prefetchResult,
      recategorize: recategorizeResult,
      clusterMaintenance: clusterMaintenanceResult,
      webDiscover: webDiscoverResult,
      prefetchDiscovered: prefetchDiscoveredResult,
      rescore: rescoreResult,
      inlineRewrite: inlineRewriteResult,
    };

    await logPipelineRun({
      job: "full",
      durationMs: Date.now() - t0,
      status: "success",
      stats: result,
    });

    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result });
  } catch (err: unknown) {
    console.error("Full cron job failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    await logPipelineRun({
      job: "full",
      durationMs: Date.now() - t0,
      status: "error",
      error: message,
    });
    return NextResponse.json(
      { ok: false, error: message, took_ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}

// Support POST for manual triggering
export const POST = GET;
