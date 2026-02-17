// app/api/cron/refresh/route.ts
// Quick refresh cron - runs 6×/day for fast content updates
export const dynamic = "force-dynamic";
export const maxDuration = 120; // 2 minutes for refresh

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

  // Light processing limits
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") || 30)),
  );

  try {
    console.log("🔄 Refresh cron job starting...");

    // 1) Quick RSS ingest
    console.log("📥 Running ingest...");
    const ingestResult = await safeRun(import("@/scripts/ingest"), {
      limit,
      closePool: false,
    });
    console.log("✅ Ingest completed:", ingestResult);

    // 2) Categorize newly ingested articles (small batch)
    console.log("🏷️  Running categorize...");
    const categorizeResult = await safeRun(import("@/scripts/categorize"), {
      limit: 30,
      closePool: false,
    });
    console.log("✅ Categorize completed:", categorizeResult);

    // 3) Prefetch content for newly ingested articles
    console.log("📖 Prefetching article content...");
    const prefetchResult = await safeRun(import("@/scripts/prefetch-content"), {
      limit: 20,
      closePool: false,
    });
    console.log("✅ Prefetch completed:", prefetchResult);

    // 3b) Re-categorize after prefetch - catches articles with content that failed initial categorization
    // Only retry articles that now have content (content_status='success')
    console.log("🏷️  Re-categorizing articles with new content...");
    const recategorizeResult = await safeRun(import("@/scripts/categorize"), {
      limit: 20,
      withContentOnly: true,
      closePool: false,
    });
    console.log("✅ Re-categorize completed:", recategorizeResult);

    // 4) Quick rescore after new articles
    console.log("🔢 Running rescore...");
    const rescoreResult = await safeRun(import("@/scripts/rescore"), {
      closePool: false,
    });
    console.log("✅ Rescore completed:", rescoreResult);

    // 5) Light web discovery - only during business hours to control costs
    let webDiscoverResult: unknown = { skipped: "off_hours" };
    const currentHour = new Date().getUTCHours();
    const isBusinessHours = currentHour >= 12 && currentHour <= 22; // 12-22 UTC = 8am-6pm ET

    // 6) Prefetch for web-discovered articles
    let prefetchDiscoveredResult: unknown = { skipped: "not_run" };

    if (isBusinessHours) {
      try {
        console.log("🔎 Running light web discovery...");
        webDiscoverResult = await safeRun(import("@/scripts/discover-web"), {
          broadArticleCap: 8,
          outletArticleCap: 15,
          outletLimitPerBatch: 5,
          outletBatchSize: 3,
          outletFreshHours: 48,
          closePool: false,
        });
        console.log("✅ Light web discovery completed");

        // Prefetch content for discovered articles
        console.log("📖 Prefetching discovered article content...");
        prefetchDiscoveredResult = await safeRun(
          import("@/scripts/prefetch-content"),
          {
            limit: 15,
            hoursAgo: 4,
            closePool: false,
          },
        );
        console.log("✅ Discovered prefetch completed");
      } catch (webError: unknown) {
        console.error("❌ Web discovery failed:", webError);
        const message =
          webError instanceof Error ? webError.message : String(webError);
        webDiscoverResult = {
          ok: false,
          error: message,
          skipped: "error",
        };
      }
    } else {
      console.log(
        `⏭️  Skipping light web discovery (off-hours: ${currentHour} UTC)`,
      );
    }

    console.log("🔄 Refresh cron job completed!");

    const result = {
      ingest: ingestResult,
      categorize: categorizeResult,
      prefetch: prefetchResult,
      recategorize: recategorizeResult,
      rescore: rescoreResult,
      webDiscover: webDiscoverResult,
      prefetchDiscovered: prefetchDiscoveredResult,
    };

    await logPipelineRun({
      job: "refresh",
      durationMs: Date.now() - t0,
      status: "success",
      stats: result,
    });

    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logPipelineRun({
      job: "refresh",
      durationMs: Date.now() - t0,
      status: "error",
      error: message,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const POST = GET;
