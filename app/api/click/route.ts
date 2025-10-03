// app/api/click/route.ts
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs"; // ensure pooled pg works
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const aid = url.searchParams.get("aid");
  const target = url.searchParams.get("url");

  // Minimal validation
  if (!aid || !target) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  // Log asynchronously; don’t block redirect
  query(`INSERT INTO article_events (article_id, event) VALUES ($1,'click')`, [
    Number(aid),
  ]).catch(() => {});

  // Safe 302 to the external article
  return NextResponse.redirect(target, { status: 302 });
}
