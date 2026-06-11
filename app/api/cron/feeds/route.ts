// app/api/cron/feeds/route.ts
// Weekly feed autodiscovery: upgrade productive pseudo-feed hosts to real RSS
// sources (scripts/discover-feeds.ts).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  try {
    console.log("📡 Feed autodiscovery cron starting...");
    const result = await safeRun(import("@/scripts/discover-feeds"), {
      apply: true,
      limit: 15,
      closePool: false,
    });
    console.log("✅ Feed autodiscovery completed:", result);

    await logPipelineRun({
      job: "feeds",
      durationMs: Date.now() - t0,
      status: "success",
      stats: result,
    });

    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logPipelineRun({
      job: "feeds",
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

export const POST = GET;
