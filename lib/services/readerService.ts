// lib/services/readerService.ts
import { query } from "@/lib/db";
import sanitize from "sanitize-html";

/**
 * Sanitize HTML content from Defuddle extraction
 * Allows semantic article elements while stripping noise
 */
function sanitizeContent(html: string): string {
  const cleaned = sanitize(html, {
    allowedTags: [
      // Headings
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      // Text structure
      "p",
      "br",
      "hr",
      // Lists
      "ul",
      "ol",
      "li",
      // Emphasis
      "strong",
      "b",
      "em",
      "i",
      // Links and media
      "a",
      "img",
      "figure",
      "figcaption",
      // Quotes
      "blockquote",
      "q",
      "cite",
      // Code (in case of technical articles)
      "pre",
      "code",
      // Tables (some articles have data tables)
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    // Force safe link attributes
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    },
    // Remove empty tags
    exclusiveFilter: (frame) => {
      const emptyTags = [
        "p",
        "div",
        "span",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ];
      return (
        emptyTags.includes(frame.tag) &&
        !frame.text.trim() &&
        !frame.mediaChildren
      );
    },
    // Don't encode entities - keep readable
    disallowedTagsMode: "discard",
  });

  // Additional cleanup for common boilerplate patterns
  return (
    cleaned
      .replace(/\[Advertisement\]/gi, "")
      .replace(/\[Skip to content\]/gi, "")
      .replace(/\[Show more\]/gi, "")
      .replace(/\[Read more\]/gi, "")
      .replace(/Share this article/gi, "")
      .replace(/Follow us on/gi, "")
      .replace(/Subscribe to our newsletter/gi, "")
      // Clean up excessive whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Extract plain text from HTML for word count and paywall detection
 */
function htmlToText(html: string): string {
  return sanitize(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

// Types
export type ReaderSuccess = {
  success: true;
  content: string;
  title: string;
  author?: string;
  wordCount: number;
  publishedAt?: string;
  image?: string;
};

export type ReaderError = {
  success: false;
  status: "paywall" | "timeout" | "blocked" | "not_found" | "error";
  error: string;
};

export type ReaderResult = ReaderSuccess | ReaderError;

const READER_ERROR_STATUS_SET = new Set<ReaderError["status"]>([
  "paywall",
  "timeout",
  "blocked",
  "not_found",
  "error",
]);

function isReaderErrorStatus(
  status: string | null,
): status is ReaderError["status"] {
  return (
    !!status && READER_ERROR_STATUS_SET.has(status as ReaderError["status"])
  );
}

// Paywall detection patterns
const PAYWALL_INDICATORS = [
  /subscribe to read/i,
  /subscription required/i,
  /become a subscriber/i,
  /sign in to continue/i,
  /this article is for subscribers/i,
  /register to continue/i,
  /members only/i,
  /premium content/i,
  /create a free account/i,
];

const BLOCKED_INDICATORS = [
  /access denied/i,
  /403 forbidden/i,
  /cloudflare/i,
  /unusual traffic/i,
];

/**
 * Detect if content appears to be a paywall message
 */
function detectPaywall(text: string, wordCount: number): boolean {
  // Very short content is suspicious
  if (wordCount < 100) {
    return PAYWALL_INDICATORS.some((pattern) => text.match(pattern));
  }

  // Check for paywall indicators in first 500 chars
  const preview = text.slice(0, 500);
  return PAYWALL_INDICATORS.some((pattern) => preview.match(pattern));
}

/**
 * Detect if we've been blocked by anti-bot measures
 */
function detectBlocked(text: string): boolean {
  return BLOCKED_INDICATORS.some((pattern) => text.match(pattern));
}

/**
 * Fetch article content using Defuddle
 * Uses dynamic imports to reduce cold start time
 */
async function fetchArticleContent(url: string): Promise<ReaderResult> {
  const startTime = Date.now();
  const TIMEOUT = 12000; // 12 seconds (increased for slower sites)

  try {
    // Dynamic imports to reduce cold start
    const [{ JSDOM }, { Defuddle }] = await Promise.all([
      import("jsdom"),
      import("defuddle/node"),
    ]);

    // Race between fetch and timeout
    const fetchPromise = (async () => {
      // Fetch with proper headers
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; ClimateRiverBot/1.0; +https://climateriver.org)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "gzip, deflate, br",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return {
            success: false,
            status: "not_found",
            error: "Article not found",
          } as ReaderError;
        }
        if (response.status === 403) {
          return {
            success: false,
            status: "blocked",
            error: "Access denied by publisher",
          } as ReaderError;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rawHtml = await response.text();

      // Parse with JSDOM
      const dom = new JSDOM(rawHtml, { url });

      // Use Defuddle to extract content in HTML mode (not markdown)
      // This avoids mixed HTML/markdown output that's hard to process
      const result = await Defuddle(dom, url, {
        debug: false,
        markdown: false, // Use HTML mode for cleaner, more consistent output
      });

      // Cleanup JSDOM to free memory
      dom.window.close();

      // Sanitize the extracted HTML
      const htmlContent = result.content ? sanitizeContent(result.content) : "";
      const textContent = htmlToText(htmlContent);
      const wordCount = textContent.split(/\s+/).filter(Boolean).length;

      // Detect paywall or blocking
      if (detectBlocked(textContent)) {
        return {
          success: false,
          status: "blocked",
          error: "Publisher blocked automated access",
        } as ReaderError;
      }

      if (detectPaywall(textContent, wordCount)) {
        return {
          success: false,
          status: "paywall",
          error: "Article requires subscription",
        } as ReaderError;
      }

      // Validate we actually got content (fixes Google News redirect issue)
      if (!htmlContent || htmlContent.length < 100 || wordCount < 50) {
        return {
          success: false,
          status: "error",
          error: `Insufficient content extracted (${wordCount} words, ${htmlContent.length} chars)`,
        } as ReaderError;
      }

      // Success!
      return {
        success: true,
        content: htmlContent,
        title: result.title || "",
        author: result.author,
        wordCount,
        publishedAt: result.published,
        image: result.image,
      } as ReaderSuccess;
    })();

    const timeoutPromise = new Promise<ReaderError>((resolve) =>
      setTimeout(() => {
        resolve({
          success: false,
          status: "timeout",
          error: `Request timed out after ${TIMEOUT}ms`,
        });
      }, TIMEOUT),
    );

    const result = await Promise.race([fetchPromise, timeoutPromise]);

    const elapsed = Date.now() - startTime;
    console.log(
      `📖 Fetched ${url} in ${elapsed}ms - ${result.success ? "SUCCESS" : result.status}`,
    );

    return result;
  } catch (error: unknown) {
    console.error("❌ Reader fetch error:", error);
    return {
      success: false,
      status: "error",
      error: error instanceof Error ? error.message : "Failed to fetch article",
    };
  }
}

/**
 * Get article content from cache or fetch if needed
 */
export async function getArticleContent(
  articleId: number,
): Promise<ReaderResult & { fromCache: boolean }> {
  // Check cache first
  const cached = await query<{
    content_html: string | null;
    content_text: string | null;
    content_word_count: number | null;
    content_status: string | null;
    content_error: string | null;
    content_fetched_at: Date | null;
    content_image: string | null;
    canonical_url: string;
    title: string;
    author: string | null;
    published_at: Date | null;
  }>(
    `
    SELECT 
      content_html,
      content_text,
      content_word_count,
      content_status,
      content_error,
      content_fetched_at,
      content_image,
      canonical_url,
      title,
      author,
      published_at
    FROM articles
    WHERE id = $1
  `,
    [articleId],
  );

  if (cached.rows.length === 0) {
    return {
      success: false,
      status: "not_found",
      error: "Article not found in database",
      fromCache: false,
    };
  }

  const article = cached.rows[0];

  // Return from cache if we have it (within 7 days)
  const cacheAge = article.content_fetched_at
    ? Date.now() - article.content_fetched_at.getTime()
    : Infinity;
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

  if (article.content_status && cacheAge < CACHE_TTL) {
    if (article.content_status === "success" && article.content_html) {
      return {
        success: true,
        content: article.content_html,
        title: article.title,
        author: article.author || undefined,
        wordCount: article.content_word_count || 0,
        publishedAt: article.published_at?.toISOString(),
        image: article.content_image || undefined,
        fromCache: true,
      };
    } else {
      // Cached error state
      const cachedStatus = isReaderErrorStatus(article.content_status)
        ? article.content_status
        : "error";
      return {
        success: false,
        status: cachedStatus,
        error: article.content_error || "Previously failed to fetch",
        fromCache: true,
      };
    }
  }

  // Cache miss or expired - fetch fresh content
  console.log(`🔄 Cache miss/expired for article ${articleId}, fetching...`);
  const result = await fetchArticleContent(article.canonical_url);

  // Store result in database
  if (result.success) {
    const textContent = htmlToText(result.content);
    await query(
      `
      UPDATE articles
      SET 
        content_html = $1,
        content_text = $2,
        content_word_count = $3,
        content_image = $4,
        content_status = 'success',
        content_error = NULL,
        content_fetched_at = NOW()
      WHERE id = $5
    `,
      [
        result.content,
        textContent,
        result.wordCount,
        result.image || null,
        articleId,
      ],
    );
  } else {
    await query(
      `
      UPDATE articles
      SET 
        content_status = $1,
        content_error = $2,
        content_fetched_at = NOW()
      WHERE id = $3
    `,
      [result.status, result.error, articleId],
    );
  }

  return { ...result, fromCache: false };
}

/**
 * Prefetch content for multiple articles (for background jobs)
 */
export async function prefetchArticles(
  articleIds: number[],
  concurrency = 2,
): Promise<void> {
  console.log(
    `🔄 Prefetching ${articleIds.length} articles with concurrency ${concurrency}`,
  );

  const queue = [...articleIds];
  const active: Array<Promise<void>> = [];

  while (queue.length > 0 || active.length > 0) {
    // Fill up to concurrency limit
    while (active.length < concurrency && queue.length > 0) {
      const id = queue.shift()!;
      const promise = getArticleContent(id)
        .then(() => {
          const idx = active.indexOf(promise);
          if (idx > -1) active.splice(idx, 1);
        })
        .catch((err) => {
          console.error(`Failed to prefetch article ${id}:`, err);
          const idx = active.indexOf(promise);
          if (idx > -1) active.splice(idx, 1);
        });
      active.push(promise);
    }

    // Wait for at least one to complete
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  console.log(`✅ Prefetch complete`);
}
