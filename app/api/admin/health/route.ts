// app/api/admin/health/route.ts
// Pipeline health dashboard — shows recent runs, staleness, and costs
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authorized } from "@/lib/cron";
import { query } from "@/lib/db";

// Expected intervals per job (in hours). If a job hasn't run within
// this window, it's flagged as stale.
const EXPECTED_INTERVALS: Record<string, number> = {
  refresh: 5, // runs every 4h, stale after 5h
  full: 9, // runs every ~7h, stale after 9h
  rewrite: 2, // runs ~hourly, stale after 2h
  cleanup: 26, // runs daily, stale after 26h
};

type JobHealth = {
  job: string;
  lastRun: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  hoursSinceLastRun: number | null;
  stale: boolean;
  recentErrors: number;
  last5: Array<{
    started_at: string;
    status: string;
    duration_ms: number | null;
    stats: unknown;
    error_msg: string | null;
  }>;
};

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    // Check if the table exists
    const tableCheck = await query(
      `SELECT to_regclass('public.pipeline_runs') AS exists`,
    );
    if (!tableCheck.rows[0]?.exists) {
      return NextResponse.json({
        ok: true,
        message:
          "pipeline_runs table does not exist yet. Run the schema script or wait for the first cron job.",
        jobs: [],
      });
    }

    const jobs = ["refresh", "full", "rewrite", "cleanup"];
    const jobHealths: JobHealth[] = [];

    for (const job of jobs) {
      // Last 5 runs
      const { rows: recent } = await query<{
        started_at: string;
        status: string;
        duration_ms: number | null;
        stats: unknown;
        error_msg: string | null;
      }>(
        `SELECT started_at, status, duration_ms, stats, error_msg
         FROM pipeline_runs
         WHERE job_name = $1
         ORDER BY started_at DESC
         LIMIT 5`,
        [job],
      );

      // Error count in last 24h
      const { rows: errCount } = await query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM pipeline_runs
         WHERE job_name = $1
           AND status = 'error'
           AND started_at >= NOW() - interval '24 hours'`,
        [job],
      );

      const lastRun = recent[0] ?? null;
      const hoursSince = lastRun
        ? (Date.now() - new Date(lastRun.started_at).getTime()) / 3_600_000
        : null;
      const threshold = EXPECTED_INTERVALS[job] ?? 24;

      jobHealths.push({
        job,
        lastRun: lastRun?.started_at ?? null,
        lastStatus: lastRun?.status ?? null,
        lastDurationMs: lastRun?.duration_ms ?? null,
        hoursSinceLastRun: hoursSince ? Math.round(hoursSince * 10) / 10 : null,
        stale: hoursSince === null || hoursSince > threshold,
        recentErrors: parseInt(errCount[0]?.count ?? "0", 10),
        last5: recent,
      });
    }

    // Source feed health summary
    const { rows: feedHealth } = await query<{
      total: string;
      healthy: string;
      erroring: string;
      stale: string;
    }>(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE last_fetch_status = 'ok') as healthy,
        COUNT(*) FILTER (WHERE last_fetch_status = 'error') as erroring,
        COUNT(*) FILTER (WHERE last_fetched_at < NOW() - interval '24 hours' OR last_fetched_at IS NULL) as stale
      FROM sources
      WHERE feed_url NOT LIKE 'discover://%'
        AND feed_url NOT LIKE 'web://%'
        AND feed_url NOT LIKE 'web-discovery://%'
    `);

    const overallHealthy = jobHealths.every(
      (j) => !j.stale && j.recentErrors === 0,
    );

    return NextResponse.json({
      ok: true,
      healthy: overallHealthy,
      jobs: jobHealths,
      feeds: feedHealth[0]
        ? {
            total: parseInt(feedHealth[0].total),
            healthy: parseInt(feedHealth[0].healthy),
            erroring: parseInt(feedHealth[0].erroring),
            stale: parseInt(feedHealth[0].stale),
          }
        : null,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
