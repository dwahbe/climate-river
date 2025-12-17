// app/api/ingest/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { headers } from "next/headers";

/** --- Types for dynamic imports (keeps TS happy without ts-expect-error) --- */
type ScriptResult = Record<string, unknown>;
type IngestMod = {
  run: (opts?: {
    limit?: number;
    closePool?: boolean;
  }) => Promise<ScriptResult>;
};
type DiscoverMod = {
  run: (opts?: {
    limitPerQuery?: number;
    closePool?: boolean;
  }) => Promise<ScriptResult>;
};

/** --- Auth helper --- */
async function authorized(req: Request) {
  const h = await headers();
  const isCron = h.get("x-vercel-cron") === "1";

  const url = new URL(req.url);
  const qToken = url.searchParams.get("token")?.trim();

  const auth = h.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();

  const expected = (process.env.ADMIN_TOKEN || "").trim();
  return isCron || (!!expected && (qToken === expected || bearer === expected));
}

/** --- Small helpers --- */
function getIntParam(
  url: URL,
  key: string,
  { min, max }: { min?: number; max?: number } = {},
): number | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** --- Runner --- */
async function handle(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const h = await headers();
  const isCron = h.get("x-vercel-cron") === "1";
  const url = new URL(req.url);

  // Controls
  let ingestLimit = getIntParam(url, "limit", { min: 1, max: 50 });
  const wantDiscover =
    (url.searchParams.get("discover") || "").toLowerCase() === "1" ||
    (url.searchParams.get("discover") || "").toLowerCase() === "true";
  const discoverLimit = getIntParam(url, "discoverLimit", { min: 1, max: 50 });

  // Default to a conservative batch size when called by cron without an explicit limit
  if (isCron && ingestLimit === undefined) ingestLimit = 25;

  const t0 = Date.now();
  const result: Record<string, unknown> = {};

  try {
    // Ingest pass
    {
      const { run } = (await import("@/scripts/ingest")) as IngestMod;
      result.ingest = await run({ limit: ingestLimit });
    }

    // Optional discovery pass (if you have scripts/discover.ts)
    if (wantDiscover) {
      try {
        const { run } = (await import("@/scripts/discover")) as DiscoverMod;
        result.discover = await run({ limitPerQuery: discoverLimit });
      } catch (e: unknown) {
        // If discover module isn't present or fails, return a soft error but keep 200
        const message = e instanceof Error ? e.message : String(e);
        result.discover = { ok: false, error: message };
      }
    }

    return NextResponse.json({
      ok: true,
      took_ms: Date.now() - t0,
      cron: isCron,
      params: { ingestLimit, wantDiscover, discoverLimit },
      result,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** --- HTTP handlers --- */
export async function GET(req: Request) {
  return handle(req);
}

export const POST = GET;
