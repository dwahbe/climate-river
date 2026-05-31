// app/api/rewrite/route.ts
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { authorized } from "@/lib/cron";

type ScriptRunner = (
  options?: Record<string, unknown>,
) => Promise<unknown> | unknown;

async function runRewrite(limit?: number) {
  const mod: { run?: ScriptRunner; default?: ScriptRunner } =
    await import("@/scripts/rewrite");
  if (typeof mod.run === "function") return mod.run({ limit });
  if (typeof mod.default === "function") return mod.default({ limit });
  throw new Error("scripts/rewrite.ts must export run()");
}

async function handle(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  const h = await headers();
  const url = new URL(req.url);
  const q = url.searchParams.get("limit");
  const isCron = h.get("x-vercel-cron") === "1";
  const limit = q
    ? Math.max(1, Math.min(100, Number(q)))
    : isCron
      ? 40
      : undefined;

  const t0 = Date.now();
  try {
    const result = await runRewrite(limit);
    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
