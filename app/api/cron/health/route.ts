// app/api/cron/health/route.ts
// Daily pipeline health check. Runs scripts/health-report.ts, logs the result
// to pipeline_runs, and (optionally) POSTs breaches to HEALTH_ALERT_WEBHOOK_URL.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { authorized, logPipelineRun } from "@/lib/cron";
import { run as healthReport } from "@/scripts/health-report";

async function sendAlert(breaches: string[], metrics: unknown) {
  const url = process.env.HEALTH_ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "climate-river-health",
        breaches,
        metrics,
        at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return true;
  } catch (err) {
    console.error("Health alert webhook failed:", err);
    return false;
  }
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const t0 = Date.now();
  try {
    const report = await healthReport({ closePool: false });
    const alerted = report.ok
      ? false
      : await sendAlert(report.breaches, report.metrics);

    await logPipelineRun({
      job: "health",
      durationMs: Date.now() - t0,
      status: report.ok ? "success" : "partial",
      stats: { breaches: report.breaches, alerted, metrics: report.metrics },
    });

    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, report });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logPipelineRun({
      job: "health",
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
