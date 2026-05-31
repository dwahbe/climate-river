// lib/cron.ts - Shared utilities for cron job routes
import { timingSafeEqual } from "node:crypto";
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

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare against a fixed-length digest-free path: bail on length mismatch,
  // but only after touching both buffers so timing doesn't leak the length.
  if (ab.length !== bb.length) {
    // timingSafeEqual requires equal lengths; compare a to itself to keep work
    // roughly constant, then return false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type CronAuthInput = {
  /** Value of the inbound `x-vercel-cron` header (or null). */
  vercelCronHeader: string | null;
  /** `?token=` query param (or null). */
  queryToken: string | null;
  /** Bearer token extracted from the Authorization header (or null). */
  bearerToken: string | null;
  /** Configured ADMIN_TOKEN (or null). */
  adminToken: string | null;
  /** Configured CRON_SECRET (or null). */
  cronSecret: string | null;
};

/**
 * Pure authorization decision for cron/admin endpoints. Authorized when:
 *  - a presented token (`Authorization: Bearer` or `?token=`) matches
 *    `ADMIN_TOKEN` or `CRON_SECRET` (constant-time), OR
 *  - the request carries Vercel's `x-vercel-cron` header AND no `CRON_SECRET`
 *    is configured — a legacy fallback so deployed crons keep working until
 *    `CRON_SECRET` is set. Once `CRON_SECRET` is configured, the spoofable
 *    header is no longer trusted on its own.
 *
 * The previous `?cron=1` query bypass and the forgeable User-Agent check have
 * been removed (they allowed any anonymous visitor to trigger the paid
 * pipeline and the destructive cleanup).
 */
export function evaluateCronAuth(input: CronAuthInput): boolean {
  const admin = (input.adminToken ?? "").trim();
  const secret = (input.cronSecret ?? "").trim();
  const presented = [input.bearerToken, input.queryToken]
    .map((t) => (t ?? "").trim())
    .filter((t) => t.length > 0);

  for (const token of presented) {
    if (admin && safeEqual(token, admin)) return true;
    if (secret && safeEqual(token, secret)) return true;
  }

  // Legacy header fallback ONLY while no CRON_SECRET is configured.
  if (!secret && input.vercelCronHeader === "1") return true;

  return false;
}

/**
 * Request adapter around {@link evaluateCronAuth}. Reads headers/query and the
 * configured secrets from the environment.
 */
export async function authorized(req: Request): Promise<boolean> {
  const h = await headers();
  const url = new URL(req.url);
  const bearer = (h.get("authorization") || "").replace(/^Bearer\s+/i, "");

  return evaluateCronAuth({
    vercelCronHeader: h.get("x-vercel-cron"),
    queryToken: url.searchParams.get("token"),
    bearerToken: bearer,
    adminToken: process.env.ADMIN_TOKEN ?? null,
    cronSecret: process.env.CRON_SECRET ?? null,
  });
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
