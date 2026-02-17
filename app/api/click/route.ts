// app/api/click/route.ts
// Uses HTML ping attribute pattern (like Google search results)
// Links use: <a href="originalUrl" ping="/api/click?aid=123">
// Benefits: users can right-click copy original links, no redirect hop
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const aid = url.searchParams.get("aid");

  if (!aid || isNaN(Number(aid))) {
    return new NextResponse(null, { status: 400 });
  }

  // Fire and forget - don't block the response
  query(`INSERT INTO article_events (article_id, event) VALUES ($1,'click')`, [
    Number(aid),
  ]).catch(() => {});

  return new NextResponse(null, { status: 204 });
}
