// app/api/rescore/route.ts
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authorized } from "@/lib/cron";

type ScriptRunner = (
  options?: Record<string, unknown>,
) => Promise<unknown> | unknown;

async function runRescore() {
  const mod: { run?: ScriptRunner; default?: ScriptRunner } =
    await import("@/scripts/rescore");
  if (typeof mod.run === "function") return mod.run({});
  if (typeof mod.default === "function") return mod.default({});
  throw new Error("scripts/rescore.ts must export run()");
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
    const result = await runRescore();
    return NextResponse.json({ ok: true, took_ms: Date.now() - t0, result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const POST = GET;
