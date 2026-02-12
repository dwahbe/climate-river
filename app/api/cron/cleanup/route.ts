// app/api/cron/cleanup/route.ts
// Daily cleanup cron - deletes articles older than 60 days
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
  const dryRun = url.searchParams.get("dry") === "1";

  try {
    console.log("🧹 Cleanup cron job starting...");
    const result = await safeRun(import("@/scripts/cleanup"), {
      dryRun,
      closePool: false,
    });
    console.log("✅ Cleanup completed:", result);

    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result });
  } catch (err: unknown) {
    console.error("Cleanup cron failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        took_ms: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}

export const POST = GET;
