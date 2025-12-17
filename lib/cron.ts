// lib/cron.ts - Shared utilities for cron job routes
import { headers } from "next/headers";

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
