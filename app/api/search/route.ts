import { NextResponse } from "next/server";
import { searchArticles } from "@/lib/services/searchService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim() || "";
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "20", 10) || 20,
      50,
    );

    if (!q || q.length < 2) {
      return NextResponse.json(
        { success: false, error: "Query must be at least 2 characters" },
        { status: 400 },
      );
    }

    const startTime = Date.now();
    const results = await searchArticles(q, limit);
    const elapsed = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      query: q,
      count: results.length,
      elapsed,
      results,
    });
  } catch (error: unknown) {
    console.error("Search API error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
