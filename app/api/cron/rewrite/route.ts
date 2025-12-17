// app/api/cron/rewrite/route.ts
// Dedicated rewrite cron - runs 16x/day for headline rewrites
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { authorized, safeRun } from "@/lib/cron";

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const t0 = Date.now();
  const url = new URL(req.url);

  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") || 25)),
  );

  try {
    console.log("✏️  Rewrite cron job starting...");

    const rewriteResult = await safeRun(import("@/scripts/rewrite"), {
      limit,
      closePool: false,
    });
    console.log("✅ Rewrite completed:", rewriteResult);

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      result: rewriteResult,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("❌ Rewrite cron job failed:", message);
    return NextResponse.json(
      { ok: false, error: message, took_ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}

export const POST = GET;
