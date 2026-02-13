// lib/cron.ts - Shared utilities for cron job routes
import { headers } from "next/headers";
import { query } from "./db";

export type ScriptOptions = Record<string, unknown> | undefined;
export type ScriptRunner<R = unknown> = (
  options?: ScriptOptions,
) => Promise<R> | R;
export type ScriptModule<R = unknown> = {
  run?: ScriptRunner<R>;
  default?: ScriptRunner<R>;
};
export type ScriptError = { ok: false; error: string };

/**
 * Check if request is authorized for cron execution.
 * Allows:
 *  - Vercel Cron (x-vercel-cron header or user-agent contains vercel-cron)
 *  - ADMIN_TOKEN via Bearer token or ?token=...
 *  - Optional ?cron=1 for manual tests
 */
export async function authorized(req: Request): Promise<boolean> {
  const h = await headers();
  const url = new URL(req.url);

  const isCron =
    h.get("x-vercel-cron") === "1" ||
    /vercel-cron/i.test(h.get("user-agent") || "") ||
    url.searchParams.get("cron") === "1";

  const expected = (process.env.ADMIN_TOKEN || "").trim();
  const qToken = url.searchParams.get("token")?.trim();
  const bearer = (h.get("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  return isCron || (!!expected && (qToken === expected || bearer === expected));
}

/**
 * Safely invoke a script module's `run` (or its default export).
 * Catches errors and returns a standardized error object.
 */
export async function safeRun<R = unknown>(
  modPromise: Promise<ScriptModule<R>>,
  opts?: ScriptOptions,
): Promise<R | ScriptError> {
  try {
    const mod = await modPromise;
    const fn = mod?.run ?? mod?.default;
    if (typeof fn !== "function") {
      console.error("❌ Script has no run/default function export");
      return { ok: false, error: "no_run_export" };
    }
    return await fn(opts);
  } catch (error: unknown) {
    console.error("❌ Script execution failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

// ---------- Pipeline run tracking ----------

let _tableChecked = false;

async function ensurePipelineTable() {
  if (_tableChecked) return;
  try {
    await query(`
      create table if not exists pipeline_runs (
        id          bigserial primary key,
        job_name    text not null,
        started_at  timestamptz not null default now(),
        finished_at timestamptz,
        duration_ms int,
        status      text not null default 'running',
        stats       jsonb,
        error_msg   text
      );
    `);
    _tableChecked = true;
  } catch {
    // Don't break cron jobs if table creation fails
  }
}

/**
 * Log a completed pipeline run. Fault-tolerant — never throws.
 */
export async function logPipelineRun(opts: {
  job: string;
  durationMs: number;
  status: "success" | "partial" | "error";
  stats?: unknown;
  error?: string;
}): Promise<void> {
  try {
    await ensurePipelineTable();
    await query(
      `INSERT INTO pipeline_runs (job_name, started_at, finished_at, duration_ms, status, stats, error_msg)
       VALUES ($1, NOW() - make_interval(secs => $2::double precision / 1000), NOW(), $2, $3, $4, $5)`,
      [
        opts.job,
        opts.durationMs,
        opts.status,
        opts.stats ? JSON.stringify(opts.stats) : null,
        opts.error ?? null,
      ],
    );
  } catch (err) {
    // Never let logging break a cron job
    console.error("Failed to log pipeline run:", err);
  }
}
