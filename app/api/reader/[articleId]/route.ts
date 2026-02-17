// app/api/reader/[articleId]/route.ts
import { NextResponse } from "next/server";
import { getArticleContent } from "@/lib/services/readerService";

export const dynamic = "force-dynamic";
export const maxDuration = 10; // Vercel timeout (10s on hobby, can increase on Pro)

type Params = {
  params: Promise<{
    articleId: string;
  }>;
};

export async function GET(request: Request, { params }: Params) {
  try {
    const { articleId } = await params;
    const id = parseInt(articleId, 10);

    if (isNaN(id) || id <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid article ID" },
        { status: 400 },
      );
    }

    const startTime = Date.now();
    const result = await getArticleContent(id);
    const elapsed = Date.now() - startTime;

    // Log for monitoring
    console.log(
      `Reader API: article ${id} - ${result.success ? "SUCCESS" : result.status} in ${elapsed}ms (cache: ${result.fromCache})`,
    );

    if (!result.success) {
      // Return specific error responses
      const statusCode =
        result.status === "not_found"
          ? 404
          : result.status === "paywall"
            ? 402 // 402 Payment Required
            : result.status === "blocked"
              ? 403
              : result.status === "timeout"
                ? 408 // Request Timeout
                : 500;

      return NextResponse.json(
        {
          success: false,
          status: result.status,
          error: result.error,
          fromCache: result.fromCache,
        },
        { status: statusCode },
      );
    }

    // Success - return content
    return NextResponse.json({
      success: true,
      data: {
        content: result.content,
        title: result.title,
        author: result.author,
        wordCount: result.wordCount,
        publishedAt: result.publishedAt,
        image: result.image,
      },
      fromCache: result.fromCache,
      timing: {
        elapsed,
      },
    });
  } catch (error: unknown) {
    console.error("Reader API error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      {
        success: false,
        status: "error",
        error: message,
      },
      { status: 500 },
    );
  }
}
