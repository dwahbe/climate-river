// scripts/discover-web.ts
import { query, endPool } from "@/lib/db";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { tavily } from "@tavily/core";
import { categorizeAndStoreArticle } from "@/lib/categorizer";
import { isClimateRelevant } from "@/lib/tagger";
import { Buffer } from "node:buffer";
import {
  CURATED_CLIMATE_OUTLETS,
  type ClimateOutlet,
} from "@/config/climateOutlets";

// Tavily client for cost-effective site-specific search
// Only initialize if API key exists (SDK throws on empty key)
const TAVILY_ENABLED = !!process.env.TAVILY_API_KEY;
const tavilyClient = TAVILY_ENABLED
  ? tavily({ apiKey: process.env.TAVILY_API_KEY! })
  : null;
const TAVILY_SEARCH_DEPTH = (process.env.TAVILY_SEARCH_DEPTH || "basic") as
  | "basic"
  | "advanced";
const TAVILY_COST_PER_SEARCH = TAVILY_SEARCH_DEPTH === "basic" ? 0.002 : 0.004;

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  source?: string;
};

type WebBrowseStats = {
  estimatedCost: number;
  toolCalls: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
};

type WebSearchOverrides = {
  systemPrompt?: string;
  userPrompt?: string;
  resultLimit?: number;
  allowedDomains?: string[];
};

type EnhancedSearchResult = {
  results: WebSearchResult[];
  browseStats: WebBrowseStats | null;
};

const GOOGLE_SUGGESTION_MODEL =
  process.env.GOOGLE_SUGGESTION_MODEL || "gpt-4o-mini";
const GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS = parseEnvInt(
  "GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS",
  600,
);

const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== "0";
const WEB_SEARCH_MODEL = process.env.WEB_SEARCH_MODEL || "gpt-4o-mini"; // Use mini for cost savings
const WEB_SEARCH_MAX_OUTPUT_TOKENS = parseEnvInt(
  "WEB_SEARCH_MAX_OUTPUT_TOKENS",
  800, // Increased to allow full JSON responses
);
const WEB_SEARCH_RESULT_LIMIT = parseEnvInt("WEB_SEARCH_LIMIT_PER_QUERY", 6);
const WEB_SEARCH_CONTEXT_SIZE = (() => {
  const raw = (process.env.WEB_SEARCH_CONTEXT_SIZE || "medium").toLowerCase();
  return raw === "low" || raw === "high" ? raw : ("medium" as const);
})();
const WEB_SEARCH_ALLOWED_DOMAINS = process.env.WEB_SEARCH_ALLOWED_DOMAINS
  ? process.env.WEB_SEARCH_ALLOWED_DOMAINS.split(",")
      .map((domain) => domain.trim())
      .filter(Boolean)
  : undefined;
const WEB_SEARCH_DEBUG = process.env.WEB_SEARCH_DEBUG === "1";
const DISCOVERY_PAUSE_MS = 1000; // Reduced from 2000ms for faster processing
const DEFAULT_OUTLET_FRESHNESS_HOURS = 72; // Reduced from 96 for fresher content
const HOST_BLOCKLIST = new Set([
  "news.google.com",
  "www.news.google.com",
  "news.yahoo.com",
  "www.news.yahoo.com",
  "msn.com",
  "www.msn.com",
]);

const APOLOGY_PATTERNS = [
  /i['']m sorry/i,
  /\bunable to (?:locate|find|retrieve)/i,
  /\bi (?:cannot|can't|couldn't|wasn't able to) (?:find|locate)/i,
  /\bas an ai\b/i,
  /\bno relevant results\b/i,
  /wasn't able to find/i,
  /couldn't find any/i,
  /no articles.*published/i,
  /i apologize/i,
];

// Patterns that indicate LLM response artifacts (not real headlines)
const LLM_ARTIFACT_PATTERNS = [
  /\*\*.*\*\*/, // Markdown bold **text**
  /\*[^*]+\*/, // Markdown italic *text*
  /\(domain:\s*[a-z.]+\)/i, // Contains (domain: example.com)
  /within the (?:past|last) \d+ hours/i, // Time reference from prompt
  /here are (?:the|some).*(?:stories|articles)/i, // LLM listing intro
  /most recent.*climate.*stories/i, // LLM response pattern
  /from \*\*[^*]+\*\*/, // "from **Source Name**"
  /i\.e\.\s*since/i, // "i.e. since November..."
];

/**
 * Validate that a title looks like a real headline, not an LLM artifact
 */
function isValidHeadlineTitle(title: string): boolean {
  if (!title || title.trim().length < 20) return false;
  if (title.length > 300) return false; // Real headlines aren't this long

  // Check for LLM artifact patterns
  if (LLM_ARTIFACT_PATTERNS.some((pattern) => pattern.test(title))) {
    console.log(
      `⚠️  Rejected LLM artifact title: "${title.substring(0, 80)}..."`,
    );
    return false;
  }

  // Check for apology patterns
  if (APOLOGY_PATTERNS.some((pattern) => pattern.test(title))) {
    console.log(`⚠️  Rejected apology title: "${title.substring(0, 80)}..."`);
    return false;
  }

  return true;
}

function normalizeDomain(domain: string): string {
  return domain
    .replace(/^www\./, "")
    .trim()
    .toLowerCase();
}

const RSS_COVERED_DOMAINS = new Set([
  "apnews.com",
  "bbc.com",
  "bbci.co.uk",
  "bloomberg.com",
  "carbonbrief.org",
  "climate.gov",
  "climatechangenews.com",
  "cleantechnica.com",
  "ft.com",
  "grist.org",
  "insideclimatenews.org",
  "jacobin.com",
  "nature.com",
  "nytimes.com",
  "reuters.com",
  "theguardian.com",
  "washingtonpost.com",
  "yaleclimateconnections.org",
]);

const DISCOVERY_OUTLETS = CURATED_CLIMATE_OUTLETS.filter(
  (outlet) => !RSS_COVERED_DOMAINS.has(normalizeDomain(outlet.domain)),
);

const RSS_SKIPPED_OUTLETS = CURATED_CLIMATE_OUTLETS.filter((outlet) =>
  RSS_COVERED_DOMAINS.has(normalizeDomain(outlet.domain)),
);

const sourceCache = new Map<string, number>();

const OUTLET_BATCH_DOMAIN_GROUPS: string[][] = [
  ["nytimes.com", "washingtonpost.com", "theguardian.com", "apnews.com"],
  ["reuters.com", "bloomberg.com", "ft.com", "politico.com"],
  [
    "insideclimatenews.org",
    "climatechangenews.com",
    "carbonbrief.org",
    "canarymedia.com",
    "heatmap.news",
  ],
  ["nationalgeographic.com", "scientificamerican.com", "nature.com", "vox.com"],
  ["restofworld.org", "mongabay.com", "downtoearth.org.in", "grist.org"],
  ["eenews.net", "wri.org", "iea.org", "weforum.org"],
  ["amnesty.org", "news.un.org", "climate.gov", "earthobservatory.nasa.gov"],
  ["carbon-pulse.com", "ember-climate.org", "energymonitor.ai", "rmi.org"],
  [
    "project-syndicate.org",
    "theatlantic.com",
    "bbc.com",
    "nationalgeographic.com",
  ],
];

const GOOGLE_SUGGESTION_OUTLET_EXAMPLES = (
  DISCOVERY_OUTLETS.length > 0 ? DISCOVERY_OUTLETS : CURATED_CLIMATE_OUTLETS
)
  .slice(0, 10)
  .map((outlet) => outlet.name)
  .join(", ");

const OPENAI_WEB_SEARCH_INPUT_PER_M = 2.5;
const OPENAI_WEB_SEARCH_OUTPUT_PER_M = 10;
const OPENAI_WEB_SEARCH_TOOL_CALL_COST = 0.015;

function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function estimateWebSearchCost(
  usage: WebBrowseStats["usage"] | null | undefined,
  toolCalls: number,
): number {
  if (!usage && !toolCalls) return 0;

  const inputTokens =
    typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage?.promptTokens === "number"
        ? usage.promptTokens
        : 0;
  const outputTokens =
    typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage?.completionTokens === "number"
        ? usage.completionTokens
        : 0;

  const fallbackTokens =
    inputTokens === 0 &&
    outputTokens === 0 &&
    typeof usage?.totalTokens === "number"
      ? usage.totalTokens
      : 0;

  const costFromTokens =
    (inputTokens / 1_000_000) * OPENAI_WEB_SEARCH_INPUT_PER_M +
    (outputTokens / 1_000_000) * OPENAI_WEB_SEARCH_OUTPUT_PER_M +
    (fallbackTokens / 1_000_000) * OPENAI_WEB_SEARCH_INPUT_PER_M;

  const totalCost =
    costFromTokens + toolCalls * OPENAI_WEB_SEARCH_TOOL_CALL_COST;
  return Number.isFinite(totalCost) ? totalCost : 0;
}

function dedupeWebResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const urlKey = result.url ? result.url.trim().toLowerCase() : "";
    const titleKey = result.title ? result.title.trim().toLowerCase() : "";
    const key = urlKey || titleKey;
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slugifyHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Common TLDs to strip when humanizing hostnames
const COMMON_TLDS = new Set([
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "io",
  "co",
  "us",
  "uk",
  "ca",
  "au",
  "de",
  "fr",
  "info",
  "biz",
]);

function humanizeHost(host: string): string {
  const segments = host.split(".");

  // Filter out common TLDs and "www"
  const meaningful = segments.filter(
    (seg) => !COMMON_TLDS.has(seg.toLowerCase()) && seg.toLowerCase() !== "www",
  );

  // If we filtered everything, just use the first segment
  if (meaningful.length === 0) {
    return segments[0]?.charAt(0).toUpperCase() + segments[0]?.slice(1) || host;
  }

  return meaningful
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function domainMatches(host: string, normalizedDomain: string): boolean {
  if (!host || !normalizedDomain) return false;
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  if (!url || allowedDomains.length === 0) return false;
  const host = hostFromUrl(url);
  if (!host) return false;
  const normalizedHost = normalizeDomain(host);
  return allowedDomains.some((domain) =>
    domainMatches(normalizedHost, normalizeDomain(domain)),
  );
}

function looksLikeApologyResult(result: WebSearchResult): boolean {
  const haystack = `${result.title ?? ""} ${result.snippet ?? ""}`
    .toLowerCase()
    .trim();
  if (!haystack) return false;
  return APOLOGY_PATTERNS.some((pattern) => pattern.test(haystack));
}

function updateDomainHitCounts(
  hitCounts: Map<string, number>,
  results: WebSearchResult[],
  normalizedDomains: string[],
) {
  if (normalizedDomains.length === 0) {
    return;
  }

  for (const result of results) {
    const host = hostFromUrl(result.url);
    if (!host) continue;
    const normalizedHost = normalizeDomain(host);
    for (const normalizedDomain of normalizedDomains) {
      if (domainMatches(normalizedHost, normalizedDomain)) {
        hitCounts.set(
          normalizedDomain,
          (hitCounts.get(normalizedDomain) ?? 0) + 1,
        );
        break;
      }
    }
  }
}

function extractJsonArrayBlock(content: string): string | null {
  if (!content) return null;

  const fenced = content.match(/```json([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].replace(/^\s+/, "").replace(/\s+$/, "");
  }

  // Look for a complete JSON array (must have opening and closing brackets)
  const inline = content.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (inline) return inline[0];

  // Fallback: try to find any array
  const anyArray = content.match(/\[[\s\S]*\]/);
  if (anyArray) {
    // Validate it looks like it contains objects, not just strings
    const arr = anyArray[0];
    if (arr.includes('"title"') || arr.includes('"url"')) {
      return arr;
    }
  }

  return null;
}

function cleanText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\*\*/g, "")
    .replace(/__+/g, "")
    .replace(/`/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1") // markdown links
    .replace(/<[^>]+>/g, "")
    .trim();
}

/**
 * Clean a snippet/dek by removing social share buttons, markdown artifacts,
 * images, navigation elements, and truncating to a reasonable length.
 */
function cleanSnippet(
  value: string | null | undefined,
  maxLength = 250,
): string {
  if (!value) return "";

  let cleaned = value
    // Remove markdown images first (before link removal)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    // Remove markdown links, keeping text
    .replace(/\[([^\]]*)\]\([^)]+(?:\s+"[^"]*")?\)/g, "$1")
    // Remove social share button text patterns
    .replace(/\b(Facebook|Twitter|Print|Email|Share this via [^)]+)\b/gi, "")
    // Remove standalone URLs
    .replace(/https?:\/\/[^\s]+/g, "")
    // Remove mailto: patterns
    .replace(/mailto:\S+/g, "")
    // Remove markdown bold/italic
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    // Remove HTML tags
    .replace(/<[^>]+>/g, "")
    // Remove markdown headers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove list markers
    .replace(/^\s*[-*]\s+/gm, "")
    // Remove image alt text patterns
    .replace(/Image \d+:/gi, "")
    // Clean up dates that appear alone
    .replace(/^\d{1,2}\s+\w+\s+\d{4}\s*/gm, "")
    // Remove category/tag-like text in square brackets
    .replace(/\[[^\]]{1,30}\]/g, "")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();

  // If the result is mostly garbage (too short or just punctuation), return empty
  if (cleaned.length < 20 || /^[\s.,!?()-]*$/.test(cleaned)) {
    return "";
  }

  // Find the first meaningful sentence (at least 40 chars ending in punctuation)
  const sentenceMatch = cleaned.match(/^(.{40,}?[.!?])\s/);
  if (sentenceMatch) {
    cleaned = sentenceMatch[1];
  }

  // Truncate if still too long
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength - 1).trimEnd() + "…";
  }

  return cleaned;
}

function parseWebSearchJson(
  content: string | null | undefined,
  query: string,
): WebSearchResult[] {
  const jsonBlock = extractJsonArrayBlock(content ?? "");
  if (!jsonBlock) return [];

  try {
    const parsed = JSON.parse(jsonBlock);
    if (!Array.isArray(parsed)) return [];

    const results: WebSearchResult[] = [];
    for (const item of parsed) {
      if (!item) continue;
      const title =
        typeof item.title === "string"
          ? cleanText(item.title)
          : typeof item.headline === "string"
            ? cleanText(item.headline)
            : "";
      const url =
        typeof item.url === "string"
          ? item.url.trim()
          : typeof item.link === "string"
            ? item.link.trim()
            : "";
      if (!title || !url) continue;

      const snippet =
        cleanText(
          typeof item.snippet === "string" && item.snippet.trim().length > 0
            ? item.snippet
            : typeof item.summary === "string" && item.summary.trim().length > 0
              ? item.summary
              : typeof item.description === "string" &&
                  item.description.trim().length > 0
                ? item.description
                : "",
        ) || `Latest coverage for "${query}"`;

      const published =
        typeof item.publishedDate === "string"
          ? item.publishedDate
          : typeof item.published_at === "string"
            ? item.published_at
            : typeof item.date === "string"
              ? item.date
              : undefined;

      let source =
        typeof item.source === "string" && item.source.trim().length > 0
          ? cleanText(item.source)
          : "";
      if (!source) {
        source = extractSourceFromUrl(url);
      }

      // Validate the title before adding to results
      if (!isValidHeadlineTitle(title)) {
        continue;
      }

      results.push({
        title,
        url,
        snippet,
        publishedDate: published,
        source,
      });
    }

    return results;
  } catch (error) {
    console.error("Error parsing web search JSON:", error);
    return [];
  }
}

async function callOpenAIWebSearch(
  query: string,
  overrides?: WebSearchOverrides,
): Promise<{ results: WebSearchResult[]; stats: WebBrowseStats | null }> {
  if (!WEB_SEARCH_ENABLED) {
    return { results: [], stats: null };
  }

  try {
    console.log(`🔎 OpenAI web search: ${query}`);

    const requestedLimit = overrides?.resultLimit ?? WEB_SEARCH_RESULT_LIMIT;
    const systemMessage =
      overrides?.systemPrompt ??
      `You are ClimateRiver's climate desk scout. Use the web search tool to find recent climate articles.

CRITICAL: Your response MUST be ONLY a valid JSON array. No text before or after.

Required format:
[{"title":"Article Title","url":"https://...","snippet":"Brief summary","publishedDate":"2025-11-25T12:00:00Z","source":"Outlet Name"}]

Rules:
- Only include articles from the past 72 hours
- Only include articles from the specified domains
- Reject aggregator URLs (news.google.com, yahoo, msn)
- Each item MUST have: title, url, snippet, publishedDate (ISO 8601), source
- Sort newest to oldest
- If no articles found, return empty array: []`;
    const userMessage =
      overrides?.userPrompt ??
      `Find up to ${requestedLimit} vetted climate or environment-related articles for: "${query}". Require publish dates within the past 72 hours, prioritize investigative/policy/science/finance impact, and ensure each entry includes a trustworthy ISO timestamp. If fewer than ${requestedLimit} items qualify, only return the smaller set. Sort newest to oldest before responding.`;
    const allowedDomains =
      overrides?.allowedDomains && overrides.allowedDomains.length > 0
        ? overrides.allowedDomains
        : WEB_SEARCH_ALLOWED_DOMAINS;

    // Note: filters.allowedDomains is NOT supported with gpt-4o-mini
    // We rely on the prompt to guide domain-specific searches and post-filter results
    const response = await generateText({
      model: openai(WEB_SEARCH_MODEL),
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      tools: {
        webSearch: openai.tools.webSearch({
          searchContextSize: WEB_SEARCH_CONTEXT_SIZE,
        }),
      },
      toolChoice: "auto",
      maxOutputTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
      providerOptions: {
        openai: {
          maxCompletionTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
        },
      },
    });

    let results = parseWebSearchJson(response.text, query);
    if (results.length === 0) {
      console.log(
        "Web search returned no structured results; attempting fallback parsing",
      );
      if (WEB_SEARCH_DEBUG && response.text) {
        console.log(
          "Web search response text preview:",
          response.text.substring(0, 200),
        );
      }
      if (
        WEB_SEARCH_DEBUG &&
        Array.isArray(response.toolResults) &&
        response.toolResults.length > 0
      ) {
        console.log(
          "Web search tool result sample:",
          JSON.stringify(response.toolResults[0] ?? null).substring(0, 200),
        );
      }
      if (
        WEB_SEARCH_DEBUG &&
        Array.isArray(response.toolCalls) &&
        response.toolCalls.length > 0
      ) {
        console.log(
          "Web search tool call sample:",
          JSON.stringify(response.toolCalls[0] ?? null).substring(0, 200),
        );
      }
      if (
        WEB_SEARCH_DEBUG &&
        Array.isArray(response.sources) &&
        response.sources.length > 0
      ) {
        console.log(
          "Web search source sample:",
          JSON.stringify(response.sources[0] ?? null).substring(0, 200),
        );
      }
      let toolDerived: WebSearchResult[] = [];
      if (response.toolResults) {
        toolDerived = extractArticlesFromToolResults(
          response.toolResults,
          query,
        );
      }
      if (toolDerived.length === 0 && response.toolCalls) {
        toolDerived = extractArticlesFromToolResults(response.toolCalls, query);
      }
      if (toolDerived.length > 0) {
        console.log(
          `Recovered ${toolDerived.length} articles from tool outputs fallback`,
        );
        results = toolDerived;
      } else {
        const sourceDerived = extractArticlesFromSources(
          response.sources,
          query,
        );
        if (sourceDerived.length > 0) {
          console.log(
            `Recovered ${sourceDerived.length} articles from source metadata fallback`,
          );
          results = sourceDerived;
        } else {
          const fallback = parseContentForArticles(response.text || "");
          if (fallback.length > 0) {
            console.log(
              "Falling back to parsed content for web search results",
            );
            results = fallback;
          }
        }
      }
    }

    results = dedupeWebResults(results);

    if (allowedDomains && allowedDomains.length > 0) {
      const before = results.length;
      results = results.filter((result) =>
        isAllowedDomain(result.url, allowedDomains),
      );
      if (WEB_SEARCH_DEBUG && before !== results.length) {
        console.log(
          `Dropped ${before - results.length} results outside allowed domains`,
        );
      }
    }

    const beforeApologyFilter = results.length;
    results = results.filter((result) => !looksLikeApologyResult(result));
    if (WEB_SEARCH_DEBUG && beforeApologyFilter !== results.length) {
      console.log(
        `Dropped ${beforeApologyFilter - results.length} apology-style results`,
      );
    }

    results = results.slice(0, requestedLimit);

    const toolCalls =
      Array.isArray(response.toolResults) && response.toolResults.length > 0
        ? response.toolResults.length
        : Array.isArray(response.toolCalls)
          ? response.toolCalls.length
          : 0;
    const usage = response.totalUsage || response.usage;
    const estimatedCost = estimateWebSearchCost(usage, toolCalls);

    if (estimatedCost > 0) {
      console.log(
        `OpenAI web search returned ${results.length} results (~$${estimatedCost.toFixed(4)})`,
      );
    } else {
      console.log(`OpenAI web search returned ${results.length} results`);
    }

    return {
      results,
      stats: {
        estimatedCost,
        toolCalls,
        usage,
      },
    };
  } catch (error) {
    console.error("Error calling OpenAI web search:", error);
    return { results: [], stats: { estimatedCost: 0, toolCalls: 0 } };
  }
}

// Tavily search - 20x cheaper than OpenAI for site-specific searches
async function searchViaTavily(
  domain: string,
  maxResults = 5,
): Promise<{ results: WebSearchResult[]; cost: number }> {
  if (!TAVILY_ENABLED) {
    return { results: [], cost: 0 };
  }

  try {
    console.log(`🔍 Tavily search: site:${domain} climate`);

    // Tavily SDK: search(query: string, options?: TavilySearchOptions)
    // tavilyClient is guaranteed non-null here because TAVILY_ENABLED check above
    const response = await tavilyClient!.search(
      `site:${domain} climate energy environment`,
      {
        searchDepth: TAVILY_SEARCH_DEPTH,
        includeAnswer: false,
        maxResults,
        includeDomains: [domain], // Use native domain filtering
        topic: "news", // Focus on news articles
        days: 7, // Last 7 days
      },
    );

    const results: WebSearchResult[] = response.results
      .filter((r) => {
        // Verify the result is actually from the target domain
        const host = hostFromUrl(r.url);
        if (
          !host ||
          !domainMatches(normalizeDomain(host), normalizeDomain(domain))
        ) {
          return false;
        }

        // Filter out category pages, homepages, and non-article URLs
        const path = new URL(r.url).pathname.toLowerCase();

        // Skip if it's just a homepage or category page
        if (path === "/" || path === "") return false;
        if (
          path.match(
            /^\/(climate|energy|environment|news|about|contact|category|tag|topics?)?\/?$/,
          )
        )
          return false;

        // Skip if title looks like a category page
        const title = r.title.toLowerCase();
        if (
          title === domain ||
          title.match(/^(climate|energy|environment|news|about)\s*$/)
        )
          return false;
        if (title.includes(" | home") || title.endsWith(" news")) return false;

        return true;
      })
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: cleanSnippet(r.content),
        publishedDate: r.publishedDate,
        source: domain,
      }));

    console.log(
      `  Tavily returned ${results.length} results (~$${TAVILY_COST_PER_SEARCH.toFixed(4)})`,
    );

    return { results, cost: TAVILY_COST_PER_SEARCH };
  } catch (error) {
    console.error(`Tavily search error for ${domain}:`, error);
    return { results: [], cost: 0 };
  }
}

// Batch Tavily search for multiple domains
async function searchViaTavilyBatch(
  domains: string[],
  maxResultsPerDomain = 4,
): Promise<{ results: WebSearchResult[]; totalCost: number }> {
  if (!TAVILY_ENABLED || domains.length === 0) {
    return { results: [], totalCost: 0 };
  }

  const allResults: WebSearchResult[] = [];
  let totalCost = 0;

  // Search each domain sequentially to respect rate limits
  for (const domain of domains) {
    const { results, cost } = await searchViaTavily(
      domain,
      maxResultsPerDomain,
    );
    allResults.push(...results);
    totalCost += cost;

    // Small delay between searches
    if (domains.indexOf(domain) < domains.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return { results: dedupeWebResults(allResults), totalCost };
}

async function callOpenAIEnhancedSearch(
  query: string,
  overrides?: WebSearchOverrides,
): Promise<EnhancedSearchResult> {
  const combined: WebSearchResult[] = [];
  let browseStats: WebBrowseStats | null = null;

  const webSearch = await callOpenAIWebSearch(query, overrides);
  if (webSearch.results.length > 0) {
    combined.push(...webSearch.results);
  }
  if (webSearch.stats) {
    browseStats = webSearch.stats;
  }

  const googleResults = await discoverViaGoogleNews(query);
  if (googleResults.length > 0) {
    combined.push(...googleResults);
  }

  return {
    results: dedupeWebResults(combined),
    browseStats,
  };
}

async function discoverViaGoogleNews(
  query: string,
): Promise<WebSearchResult[]> {
  const suggestionText = await generateGoogleNewsSuggestions(query);
  const suggestionResults = await executeAISearchSuggestions(suggestionText);

  if (suggestionResults.length > 0) {
    return suggestionResults;
  }

  console.log(
    "AI suggestions empty, falling back to direct Google News search",
  );
  return await searchGoogleNewsRSS(query);
}

async function generateGoogleNewsSuggestions(
  query: string,
): Promise<string | null> {
  console.log(`OpenAI Google News suggestions: ${query}`);

  try {
    const { text } = await generateText({
      model: openai(GOOGLE_SUGGESTION_MODEL),
      messages: [
        {
          role: "system",
          content: `You build advanced Google News RSS queries for climate reporting. Return only a JSON array. Each element must contain "searchTerm" (Google News-ready string), "reasoning" (short justification), and "expectedSources" (array). Every searchTerm must use boolean operators and/or quoted phrases, include a recency constraint such as when:1d/when:3d, and when helpful reference curated climate outlets (e.g., ${GOOGLE_SUGGESTION_OUTLET_EXAMPLES}) via site:domain or source keywords. Avoid generic requests like "climate change news". No prose outside the JSON.`,
        },
        {
          role: "user",
          content: `Provide 2-4 advanced Google News search strings to surface fresh climate or environment coverage for: "${query}". Combine climate subtopics (policy, finance, science, justice) with geography or sector cues, apply recency filters (e.g., when:1d), and bias toward reputable climate outlets. Avoid generic or repetitive phrases.`,
        },
      ],
      maxOutputTokens: GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS,
    });

    return text ?? null;
  } catch (error) {
    console.error("Error generating Google News suggestions:", error);
    return null;
  }
}

async function executeAISearchSuggestions(
  content: string | null | undefined,
): Promise<WebSearchResult[]> {
  if (!content) {
    return [];
  }

  try {
    const suggestions = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      console.log("No JSON array found in AI response");
      return [];
    }

    console.log(`AI suggested ${suggestions.length} search terms`);

    const allResults: WebSearchResult[] = [];

    for (const suggestion of suggestions.slice(0, 3)) {
      // Limit to 3 suggestions
      const searchTerm = suggestion.searchTerm || suggestion.search_term;
      if (!searchTerm) continue;

      console.log(`Executing AI suggestion: "${searchTerm}"`);
      const results = await searchGoogleNewsRSS(searchTerm);
      allResults.push(...results);

      // Small delay between searches
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return allResults;
  } catch (error) {
    console.error("Error executing AI search suggestions:", error);
    return [];
  }
}

async function searchGoogleNewsRSS(query: string): Promise<WebSearchResult[]> {
  // Import RSS parser
  const Parser = (await import("rss-parser")).default;
  const parser = new Parser({
    headers: {
      "User-Agent": "ClimateRiverBot/0.1 (+https://climateriver.org)",
    },
    requestOptions: { timeout: 10000 },
  });

  try {
    // Google News RSS search URL
    const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

    const feed = await parser.parseURL(searchUrl);

    const results: WebSearchResult[] = [];
    const items = (feed.items || []).slice(0, 5); // Limit to 5 results per query

    for (const item of items) {
      if (!item.title || !item.link) continue;

      // Extract the real URL from Google News redirect
      const realUrl = extractRealUrl(item.link);

      results.push({
        title: cleanGoogleNewsTitle(item.title),
        url: realUrl,
        snippet: item.contentSnippet || item.content || "",
        publishedDate: item.isoDate || item.pubDate,
        source: extractSourceFromUrl(realUrl),
      });
    }

    return results;
  } catch (error) {
    console.error(`Error searching Google News for "${query}":`, error);
    return [];
  }
}

const GOOGLE_TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ved",
  "usg",
  "oc",
  "si",
  "gclid",
  "fbclid",
]);

function extractRealUrl(googleUrl: string): string {
  try {
    const url = new URL(googleUrl);
    if (!url.hostname.includes("news.google.com")) {
      return googleUrl;
    }

    const candidateSegments = [
      url.searchParams.get("url"),
      url.searchParams.get("q"),
      url.searchParams.get("u"),
    ].filter((segment): segment is string => Boolean(segment));

    const pathSegments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });

    for (const candidate of [...candidateSegments, ...pathSegments]) {
      const resolved = resolveGoogleNewsCandidate(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return googleUrl;
  } catch {
    return googleUrl;
  }
}

function resolveGoogleNewsCandidate(
  candidate: string | undefined,
): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("http")) {
    return stripTrackingParams(trimmed);
  }

  const decoded = maybeDecodeBase64Url(trimmed);
  if (decoded?.startsWith("http")) {
    return stripTrackingParams(decoded);
  }

  return null;
}

function maybeDecodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    return null;
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = normalized + "=".repeat((4 - padding) % 4);

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function stripTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const param of GOOGLE_TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function normalizePublishedDate(
  value: string | Date | null | undefined,
): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Validate that a date is reasonable for a news article
function isValidArticleDate(date: Date | null): {
  valid: boolean;
  reason?: string;
} {
  if (!date) return { valid: false, reason: "missing date" };

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneMinuteFromNow = new Date(now.getTime() + 60 * 1000);

  // Reject future dates (with 1 minute grace for clock skew)
  if (date > oneMinuteFromNow) {
    return { valid: false, reason: `future date: ${date.toISOString()}` };
  }

  // Warn if date is very close to now (within 30 seconds) - likely a fallback to NOW()
  if (Math.abs(date.getTime() - now.getTime()) < 30 * 1000) {
    return { valid: false, reason: "date suspiciously close to current time" };
  }

  // Web discovery should only get articles from the last 7 days
  if (date < sevenDaysAgo) {
    return { valid: false, reason: `too old: ${date.toISOString()}` };
  }

  return { valid: true };
}

function isResultFresh(result: WebSearchResult, cutoffMs: number): boolean {
  const publishedAt = normalizePublishedDate(result.publishedDate);
  if (!publishedAt) {
    // CRITICAL: Reject articles without dates to prevent old content from appearing as new
    // This was causing 10-month-old articles to appear as "2 days ago"
    return false;
  }
  return publishedAt.getTime() >= cutoffMs;
}

function cleanGoogleNewsTitle(title: string): string {
  // Remove trailing " - Source Name" from Google News titles
  return title.replace(/\s-\s[^-]+$/, "").trim();
}

function parseContentForArticles(content: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // Look for URLs in the content
  const urlRegex = /https?:\/\/[^\s)\]]+/g;
  const urls = content.match(urlRegex) || [];

  // Split content into meaningful chunks
  const lines = content.split("\n").filter((line) => line.trim());

  // Look for various patterns that indicate articles
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip headers and meta information
    if (
      line.startsWith("#") ||
      line.toLowerCase().includes("found") ||
      line.toLowerCase().includes("search")
    ) {
      continue;
    }

    // Pattern 1: "Title - Source" format
    let titleSourceMatch = line.match(/^[\d.\s]*(.+?)\s*[-–]\s*(.+)$/);

    // Pattern 2: "Title (Source)" format
    if (!titleSourceMatch) {
      titleSourceMatch = line.match(/^[\d.\s]*(.+?)\s*\((.+?)\)\s*$/);
    }

    // Pattern 3: Look for lines that might be titles followed by URLs
    if (!titleSourceMatch && line.length > 20 && !line.includes("http")) {
      // Check if next lines contain URLs
      const nextLines = lines.slice(i + 1, i + 3);
      const nextUrl = nextLines.find((l) => l.includes("http"));

      if (nextUrl) {
        const urlMatch = nextUrl.match(/https?:\/\/[^\s)\]]+/);
        if (urlMatch) {
          const potentialTitle = line.replace(/^[\d.\s]*/, "").trim();
          // Validate that title doesn't look like raw JSON (be specific to avoid false positives)
          const looksLikeJson =
            /^["'](title|url|publishedDate|headline|link|description|snippet)["']\s*:/.test(
              potentialTitle,
            ) ||
            potentialTitle.includes('": "') ||
            (potentialTitle.startsWith("{") && potentialTitle.includes(":"));

          if (!looksLikeJson) {
            results.push({
              title: potentialTitle,
              url: urlMatch[0],
              snippet:
                nextLines.find((l) => !l.includes("http") && l.length > 10) ||
                "Climate news article",
              source: extractSourceFromUrl(urlMatch[0]),
              publishedDate: new Date().toISOString(),
            });
          }
        }
      }
    }

    if (titleSourceMatch && titleSourceMatch[1] && titleSourceMatch[2]) {
      const title = titleSourceMatch[1].trim();
      let source = titleSourceMatch[2].trim();

      // Clean up the source (remove dates, extra info)
      source = source.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/, "").trim();
      source = source.replace(/^\s*-\s*/, "").trim();

      // Find corresponding URL
      let correspondingUrl = urls.find((url) => {
        const hostname = extractSourceFromUrl(url).toLowerCase();
        const sourceWords = source.toLowerCase().split(" ");
        return sourceWords.some(
          (word) => word.length > 3 && hostname.includes(word),
        );
      });

      // Fallback: use any available URL
      if (!correspondingUrl && urls.length > results.length) {
        correspondingUrl = urls[results.length];
      }

      // Validate that title doesn't look like raw JSON (be specific to avoid false positives)
      const looksLikeJson =
        /^["'](title|url|publishedDate|headline|link|description|snippet)["']\s*:/.test(
          title,
        ) ||
        title.includes('": "') ||
        (title.startsWith("{") && title.includes(":"));

      if (correspondingUrl && title.length > 10 && !looksLikeJson) {
        results.push({
          title: title,
          url: correspondingUrl,
          snippet: `Recent coverage: ${title.substring(0, 100)}...`,
          source: source,
          publishedDate: new Date().toISOString(),
        });
      }
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function parseUnknownContentForArticles(
  content: unknown,
  query: string,
): WebSearchResult[] {
  if (content == null) {
    return [];
  }

  if (typeof content === "string" && content.trim().length > 0) {
    const structured = parseWebSearchJson(content, query);
    if (structured.length > 0) {
      return structured;
    }
    return parseContentForArticles(content);
  }

  try {
    const serialized = JSON.stringify(content);
    if (serialized && serialized.length > 2) {
      const structured = parseWebSearchJson(serialized, query);
      if (structured.length > 0) {
        return structured;
      }
      return parseContentForArticles(serialized);
    }
  } catch (error) {
    if (WEB_SEARCH_DEBUG) {
      console.log("Unable to stringify tool result output:", error);
    }
  }

  return [];
}

function extractArticlesFromToolResults(
  toolResults: unknown,
  query: string,
): WebSearchResult[] {
  if (!Array.isArray(toolResults)) {
    return [];
  }

  const aggregated: WebSearchResult[] = [];

  for (const toolResult of toolResults) {
    if (!toolResult || typeof toolResult !== "object") continue;

    const toolName =
      typeof (toolResult as { toolName?: unknown }).toolName === "string"
        ? ((toolResult as { toolName?: string }).toolName ?? "")
        : "";

    if (
      toolName &&
      toolName !== "web_search" &&
      toolName !== "webSearch" &&
      toolName !== "web_search_preview"
    ) {
      continue;
    }

    const payloads = [
      (toolResult as { output?: unknown }).output,
      (toolResult as { result?: unknown }).result,
      (toolResult as { data?: unknown }).data,
    ];

    for (const payload of payloads) {
      const parsed = parseUnknownContentForArticles(payload, query);
      if (parsed.length > 0) {
        aggregated.push(...parsed);
        break;
      }
    }
  }

  return aggregated;
}

function extractArticlesFromSources(
  sources: unknown,
  query: string,
): WebSearchResult[] {
  if (!Array.isArray(sources)) {
    return [];
  }

  const results: WebSearchResult[] = [];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const sourceType =
      typeof (source as { sourceType?: unknown }).sourceType === "string"
        ? ((source as { sourceType?: string }).sourceType ?? "")
        : "";

    if (sourceType && sourceType !== "url") {
      continue;
    }

    const url =
      typeof (source as { url?: unknown }).url === "string"
        ? ((source as { url?: string }).url ?? "")
        : "";

    if (!url) continue;

    const title =
      typeof (source as { title?: unknown }).title === "string"
        ? cleanText((source as { title?: string }).title ?? "")
        : "";

    results.push({
      title: title || `Referenced source for "${query}"`,
      url,
      snippet: title
        ? `Source cited for "${title}"`
        : `Source referenced for "${query}"`,
      publishedDate: undefined,
      source: extractSourceFromUrl(url),
    });
  }

  return results;
}

function extractSourceFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname;
  } catch {
    return "Unknown";
  }
}

async function isDuplicate(title: string, url: string): Promise<boolean> {
  // Check if we already have this article by URL
  const existingByUrl = await query(
    "SELECT id FROM articles WHERE canonical_url = $1",
    [url],
  );

  if (existingByUrl.rows.length > 0) {
    return true;
  }

  // Check for similar title (basic duplicate detection)
  const normalizedTitle = title.trim().toLowerCase();

  if (normalizedTitle) {
    const existingByTitle = await query(
      "SELECT id FROM articles WHERE LOWER(title) = $1 AND fetched_at > NOW() - INTERVAL '48 hours'",
      [normalizedTitle],
    );

    if (existingByTitle.rows.length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a string looks like a raw domain (e.g., "heatmap.news", "news.un.org")
 * vs a proper outlet name (e.g., "Heatmap News", "UN News Climate")
 */
function looksLikeDomain(name: string): boolean {
  if (!name) return false;
  // A domain typically has no spaces, contains dots, and matches domain pattern
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name.trim());
}

async function getOrCreateSourceForResult(
  result: WebSearchResult,
  fallbackSourceId: number,
): Promise<{
  sourceId: number;
  publisherName?: string | null;
  publisherHomepage?: string | null;
}> {
  const host = hostFromUrl(result.url);

  if (!host || HOST_BLOCKLIST.has(host)) {
    // Only use result.source if it's a real name, not a domain
    const sourceName = result.source?.trim();
    return {
      sourceId: fallbackSourceId,
      publisherName:
        sourceName && !looksLikeDomain(sourceName) ? sourceName : null,
      publisherHomepage: null,
    };
  }

  const slug = slugifyHost(host);
  const feedUrl = `web://${host}`;
  const homepage = `https://${host}`;

  // Check if we already have this source with a proper name
  const existing = await query<{ id: number; name: string }>(
    `
      SELECT id, name
      FROM sources
      WHERE slug = $1
         OR feed_url = $2
         OR lower(coalesce(homepage_url, '')) LIKE $3
      ORDER BY weight DESC
      LIMIT 1
    `,
    [slug, feedUrl, `%${host}%`],
  );

  if (existing.rows[0]) {
    const sourceId = existing.rows[0].id;
    sourceCache.set(host, sourceId);

    // The source table has a proper name, so don't override with publisher_name
    // Let the query's coalesce fall back to the source name
    return {
      sourceId,
      publisherName: null, // Will use source.name via coalesce
      publisherHomepage: homepage,
    };
  }

  // No existing source - determine the best name to use
  const resultSource = result.source?.trim();
  // Only use result.source if it's a proper name, not a domain
  const publisherName =
    resultSource && !looksLikeDomain(resultSource)
      ? resultSource
      : humanizeHost(host);

  // Default weight of 2 for web-discovered sources (lower than curated RSS sources)
  // This prevents random/low-quality sites from ranking as high as major outlets
  const DEFAULT_WEB_DISCOVERED_WEIGHT = 2;

  const inserted = await query<{ id: number }>(
    `
      INSERT INTO sources (name, homepage_url, feed_url, weight, slug)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (feed_url) DO UPDATE
        SET name = EXCLUDED.name,
            homepage_url = EXCLUDED.homepage_url,
            slug = EXCLUDED.slug
        -- NOTE: Don't override weight on conflict - preserve any manual adjustments
      RETURNING id
    `,
    [publisherName, homepage, feedUrl, DEFAULT_WEB_DISCOVERED_WEIGHT, slug],
  );

  const sourceId = inserted.rows[0]?.id;

  if (!sourceId) {
    return {
      sourceId: fallbackSourceId,
      publisherName: null,
      publisherHomepage: homepage,
    };
  }

  sourceCache.set(host, sourceId);

  // New source was just created with publisherName, so set it on the article too
  return {
    sourceId,
    publisherName,
    publisherHomepage: homepage,
  };
}

async function insertWebDiscoveredArticle(
  result: WebSearchResult,
  sourceId: number,
  publisherName?: string | null,
  publisherHomepage?: string | null,
): Promise<number | null> {
  try {
    // Validate the published date
    const publishedDate = normalizePublishedDate(result.publishedDate);
    const dateValidation = isValidArticleDate(publishedDate);

    if (!dateValidation.valid) {
      console.log(
        `⚠️  Skipping web-discovered article with invalid date (${dateValidation.reason}): "${result.title.substring(0, 60)}..."`,
      );
      return null;
    }

    const { rows } = await query<{ id: number }>(
      `
      INSERT INTO articles (
        source_id, 
        title, 
        canonical_url, 
        dek,
        published_at,
        fetched_at,
        publisher_name,
        publisher_homepage
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
      RETURNING id
    `,
      [
        sourceId,
        result.title,
        result.url,
        result.snippet,
        publishedDate, // Now guaranteed to be valid, no fallback needed
        publisherName ?? null,
        publisherHomepage ?? null,
      ],
    );

    return rows[0]?.id || null;
  } catch (error) {
    console.error("Error inserting web discovered article:", error);
    return null;
  }
}

async function getOrCreateWebDiscoverySource(): Promise<number> {
  // Check if we have a "Web Discovery" source
  const existing = await query<{ id: number }>(
    "SELECT id FROM sources WHERE slug = $1",
    ["web-discovery"],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Create the web discovery source
  const { rows } = await query<{ id: number }>(
    `
    INSERT INTO sources (name, homepage_url, feed_url, weight, slug)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `,
    [
      "Web Discovery",
      "https://climateriver.org",
      "web-discovery://openai",
      4.0, // High weight for curated discoveries
      "web-discovery",
    ],
  );

  return rows[0].id;
}

async function ensureClusterForArticle(articleId: number, title: string) {
  // Simple clustering based on title keywords (reuse your existing logic)
  const titleWords = title.toLowerCase().split(" ");
  const keywords = titleWords.filter((w) => w.length > 4).slice(0, 3);
  const clusterKey = keywords.join("-") || `article-${articleId}`;

  // Get or create cluster
  const { rows: clusters } = await query<{ id: number }>(
    `
    INSERT INTO clusters (key, created_at)
    VALUES ($1, NOW())
    ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
    RETURNING id
  `,
    [clusterKey],
  );

  const clusterId = clusters[0].id;

  // Link article to cluster
  await query(
    `
    INSERT INTO article_clusters (article_id, cluster_id)
    VALUES ($1, $2)
    ON CONFLICT (article_id, cluster_id) DO NOTHING
  `,
    [articleId, clusterId],
  );
}

type DiscoverySegmentStats = {
  inserted: number;
  scanned: number;
  queriesRun: number;
  browseCost: number;
  browseToolCalls: number;
  duration: number;
};

async function tryInsertDiscoveredArticle(
  result: WebSearchResult,
  fallbackSourceId: number,
): Promise<boolean> {
  // FIRST: Validate the title is a real headline, not an LLM artifact
  if (!isValidHeadlineTitle(result.title)) {
    return false;
  }

  const isClimate = isClimateRelevant({
    title: result.title,
    summary: result.snippet ?? undefined,
  });

  if (!isClimate) {
    const host = hostFromUrl(result.url) || result.source || "unknown source";
    console.log(
      `- Skipped non-climate result from ${host}: ${result.title.substring(0, 80)}`,
    );
    return false;
  }

  const duplicate = await isDuplicate(result.title, result.url);

  if (duplicate) {
    console.log(`- Skipped duplicate: ${result.title.substring(0, 60)}...`);
    return false;
  }

  const { sourceId, publisherName, publisherHomepage } =
    await getOrCreateSourceForResult(result, fallbackSourceId);

  const articleId = await insertWebDiscoveredArticle(
    result,
    sourceId,
    publisherName,
    publisherHomepage,
  );

  if (!articleId) {
    return false;
  }

  await ensureClusterForArticle(articleId, result.title);

  try {
    await categorizeAndStoreArticle(
      articleId,
      result.title,
      result.snippet || undefined,
    );
    console.log(`✓ Added & categorized: ${result.title.substring(0, 60)}...`);
  } catch (error) {
    console.error(`  ❌ Failed to categorize article ${articleId}:`, error);
    console.log(`✓ Added (uncategorized): ${result.title.substring(0, 60)}...`);
  }

  return true;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function buildOutletBatches(batchSize: number): ClimateOutlet[][] {
  const byDomain = new Map(
    DISCOVERY_OUTLETS.map((outlet) => [outlet.domain, outlet]),
  );
  const assigned = new Set<string>();
  const batches: ClimateOutlet[][] = [];

  for (const domains of OUTLET_BATCH_DOMAIN_GROUPS) {
    const batch = domains
      .map((domain) => {
        const outlet = byDomain.get(domain);
        if (outlet && !assigned.has(domain)) {
          assigned.add(domain);
          return outlet;
        }
        return null;
      })
      .filter((outlet): outlet is ClimateOutlet => Boolean(outlet));

    if (batch.length > 0) {
      batches.push(batch);
    }
  }

  const leftovers = DISCOVERY_OUTLETS.filter(
    (outlet) => !assigned.has(outlet.domain),
  );

  for (const chunk of chunkArray(leftovers, batchSize)) {
    if (chunk.length > 0) {
      batches.push(chunk);
    }
  }

  return batches;
}

async function runOutletDiscoverySegment({
  fallbackSourceId,
  limitPerBatch,
  batchSize,
  articleCap,
  freshHours,
}: {
  fallbackSourceId: number;
  limitPerBatch: number;
  batchSize: number;
  articleCap: number;
  freshHours: number;
}): Promise<DiscoverySegmentStats> {
  if (DISCOVERY_OUTLETS.length === 0 || articleCap <= 0) {
    return {
      inserted: 0,
      scanned: 0,
      queriesRun: 0,
      browseCost: 0,
      browseToolCalls: 0,
      duration: 0,
    };
  }

  const segmentStart = Date.now();
  const outletBatches = buildOutletBatches(batchSize);
  const freshnessCutoffMs =
    freshHours > 0 ? Date.now() - freshHours * 60 * 60 * 1000 : null;

  let inserted = 0;
  let scanned = 0;
  let queriesRun = 0;
  let browseCost = 0;
  let browseToolCalls = 0;

  for (const batch of outletBatches) {
    if (inserted >= articleCap) {
      break;
    }

    const outletNames = batch.map((outlet) => outlet.promptHint || outlet.name);
    const domains = batch.map((outlet) => outlet.domain);
    const normalizedDomainEntries = batch.map((outlet) => ({
      outlet,
      raw: outlet.domain,
      normalized: normalizeDomain(outlet.domain),
    }));

    console.log(`Searching (site-specific batch): ${outletNames.join(", ")}`);

    // TIER 1: Try Tavily first (20x cheaper than OpenAI)
    let batchResults: WebSearchResult[] = [];

    if (TAVILY_ENABLED) {
      console.log(`  → Tier 1: Tavily search for ${domains.length} domains`);
      const { results: tavilyResults, totalCost } = await searchViaTavilyBatch(
        domains,
        Math.ceil(limitPerBatch / domains.length),
      );
      batchResults = tavilyResults;
      browseCost += totalCost;
      queriesRun += domains.length;
    }

    // Check which domains got results from Tavily
    const domainHitCounts = new Map<string, number>();
    updateDomainHitCounts(
      domainHitCounts,
      batchResults,
      normalizedDomainEntries.map((entry) => entry.normalized),
    );

    const missingDomainEntries = normalizedDomainEntries.filter(
      (entry) => (domainHitCounts.get(entry.normalized) ?? 0) === 0,
    );

    // TIER 2: Fall back to OpenAI for domains Tavily missed
    if (missingDomainEntries.length > 0) {
      console.log(
        `  → Tier 2: OpenAI fallback for ${missingDomainEntries.length} domains: ${missingDomainEntries
          .map((entry) => entry.outlet.name)
          .join(", ")}`,
      );

      const missingDomains = missingDomainEntries.map((e) => e.raw);
      const missingDescriptors = missingDomainEntries.map((e) =>
        e.outlet.promptHint
          ? `${e.outlet.name} (${e.outlet.promptHint})`
          : e.outlet.name,
      );

      const targetedSystemPrompt = `You are ClimateRiver's climate outlet curator. For each outlet you must issue at least one precise site:domain query that reflects the outlet's specialty while keeping total tool calls as low as possible. Only keep original articles published in the past ${freshHours} hours. Reject syndicated content, opinion newsletters, or aggregator redirections. Double-check that every URL's hostname belongs to the allowed domain list and drop any entry without a confirmed ISO timestamp. Respond with a JSON array sorted newest to oldest containing title, url, snippet (why the story matters), publishedDate (ISO), and source.`;
      const targetedUserPrompt = `Provide up to ${limitPerBatch} combined articles across these outlets: ${missingDescriptors.join("; ")}. Use site-specific queries (e.g., site:domain "topic") tailored to each prompt hint, and when possible include at least one qualifying link per outlet. Only include URLs from ${missingDomains.join(", ")} or their official climate sections, ensure every item was published within the last ${freshHours} hours, and omit any link that fails those tests. Return only the JSON array sorted newest to oldest.`;

      const { results: openAIResults, browseStats } =
        await callOpenAIEnhancedSearch(
          `Latest climate coverage across: ${missingDomains.join(", ")}`,
          {
            systemPrompt: targetedSystemPrompt,
            userPrompt: targetedUserPrompt,
            allowedDomains: missingDomains,
            resultLimit: limitPerBatch,
          },
        );

      queriesRun++;

      if (browseStats) {
        browseCost += browseStats.estimatedCost;
        browseToolCalls += browseStats.toolCalls;
      }

      batchResults.push(...openAIResults);

      // Update hit counts after OpenAI results
      updateDomainHitCounts(
        domainHitCounts,
        openAIResults,
        missingDomainEntries.map((entry) => entry.normalized),
      );
    }

    // Check for still-missing domains after both tiers
    const stillMissingEntries = normalizedDomainEntries.filter(
      (entry) => (domainHitCounts.get(entry.normalized) ?? 0) === 0,
    );

    if (stillMissingEntries.length > 0) {
      console.log(
        `⚠️ Still missing coverage after all tiers: ${stillMissingEntries
          .map((entry) => entry.outlet.name)
          .join(", ")}`,
      );
    }

    // Dedupe before processing
    batchResults = dedupeWebResults(batchResults);
    scanned += batchResults.length;

    for (const result of batchResults) {
      if (inserted >= articleCap) break;
      if (freshnessCutoffMs && !isResultFresh(result, freshnessCutoffMs)) {
        console.log(
          `- Skipped stale (${result.publishedDate ?? "unknown"}): ${result.title.substring(0, 80)}`,
        );
        continue;
      }
      const added = await tryInsertDiscoveredArticle(result, fallbackSourceId);
      if (added) {
        inserted++;
      }
    }

    if (inserted >= articleCap) break;
    await delay(DISCOVERY_PAUSE_MS);
  }

  return {
    inserted,
    scanned,
    queriesRun,
    browseCost,
    browseToolCalls,
    duration: Math.round((Date.now() - segmentStart) / 1000),
  };
}

// Broad climate discovery - searches the web generally for high-quality climate content
async function runBroadClimateDiscovery({
  fallbackSourceId,
  articleCap,
  freshHours,
}: {
  fallbackSourceId: number;
  articleCap: number;
  freshHours: number;
}): Promise<DiscoverySegmentStats> {
  if (!TAVILY_ENABLED || articleCap <= 0) {
    return {
      inserted: 0,
      scanned: 0,
      queriesRun: 0,
      browseCost: 0,
      browseToolCalls: 0,
      duration: 0,
    };
  }

  const segmentStart = Date.now();
  const freshnessCutoffMs =
    freshHours > 0 ? Date.now() - freshHours * 60 * 60 * 1000 : null;

  let inserted = 0;
  let scanned = 0;
  let browseCost = 0;

  // Broad climate search queries - varied to capture different types of content
  const broadQueries = [
    "climate change policy legislation 2025",
    "renewable energy solar wind investment",
    "carbon emissions reduction net zero",
    "climate science research report",
    "clean energy transition electric vehicles",
  ];

  // Domains to exclude (social media, aggregators, low-quality)
  const excludeDomains = [
    "twitter.com",
    "x.com",
    "facebook.com",
    "reddit.com",
    "linkedin.com",
    "youtube.com",
    "tiktok.com",
    "instagram.com",
    "news.google.com",
    "news.yahoo.com",
    "msn.com",
    "pinterest.com",
    "tumblr.com",
    "medium.com",
  ];

  console.log(`\n🌍 Broad Climate Discovery (${broadQueries.length} queries)`);

  for (const searchQuery of broadQueries) {
    if (inserted >= articleCap) break;

    try {
      console.log(`  → Searching: "${searchQuery}"`);

      // tavilyClient guaranteed non-null (TAVILY_ENABLED check at function start)
      const response = await tavilyClient!.search(searchQuery, {
        searchDepth: TAVILY_SEARCH_DEPTH,
        topic: "news",
        days: 3, // Focus on very recent content
        maxResults: 5,
        excludeDomains,
        includeAnswer: false,
      });

      browseCost += TAVILY_COST_PER_SEARCH;

      const results: WebSearchResult[] = response.results
        .filter((r) => {
          // Filter out category pages, homepages
          const path = new URL(r.url).pathname.toLowerCase();
          if (path === "/" || path === "") return false;
          if (
            path.match(
              /^\/(climate|energy|environment|news|about|contact|category|tag|topics?)?\/?$/,
            )
          )
            return false;
          return true;
        })
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: cleanSnippet(r.content),
          publishedDate: r.publishedDate,
          source: hostFromUrl(r.url) || "unknown",
        }));

      scanned += results.length;
      console.log(`    Found ${results.length} results`);

      for (const result of results) {
        if (inserted >= articleCap) break;
        if (freshnessCutoffMs && !isResultFresh(result, freshnessCutoffMs)) {
          continue;
        }
        const added = await tryInsertDiscoveredArticle(
          result,
          fallbackSourceId,
        );
        if (added) {
          inserted++;
        }
      }

      // Small delay between queries
      await delay(300);
    } catch (error) {
      console.error(`  Error in broad search "${searchQuery}":`, error);
    }
  }

  console.log(
    `  Broad discovery complete: ${inserted} articles from ${scanned} results`,
  );

  return {
    inserted,
    scanned,
    queriesRun: broadQueries.length,
    browseCost,
    browseToolCalls: 0,
    duration: Math.round((Date.now() - segmentStart) / 1000),
  };
}

export async function run(
  opts: {
    closePool?: boolean;
    broadArticleCap?: number;
    outletArticleCap?: number;
    outletLimitPerBatch?: number;
    outletBatchSize?: number;
    outletFreshHours?: number;
  } = {},
) {
  const startTime = Date.now();
  const broadArticleCap = opts.broadArticleCap ?? 15; // Broad discovery cap
  const outletArticleCap = opts.outletArticleCap ?? 70;
  const outletLimitPerBatch = Math.max(4, opts.outletLimitPerBatch ?? 12);
  const outletBatchSize = Math.max(2, opts.outletBatchSize ?? 4);
  const outletFreshHours =
    opts.outletFreshHours ?? DEFAULT_OUTLET_FRESHNESS_HOURS;

  console.log("Starting web discovery...");
  console.log(
    `Search tiers: ${TAVILY_ENABLED ? "0) Broad → 1) Tavily → " : ""}2) OpenAI → 3) Google News`,
  );

  if (RSS_SKIPPED_OUTLETS.length > 0) {
    console.log(
      `Skipping ${RSS_SKIPPED_OUTLETS.length} RSS-backed outlets for OpenAI discovery: ${RSS_SKIPPED_OUTLETS.map((outlet) => outlet.name).join(", ")}`,
    );
  }

  if (DISCOVERY_OUTLETS.length === 0) {
    console.log(
      "No eligible outlets remain for OpenAI discovery (all covered via RSS)",
    );
  }

  const fallbackSourceId = await getOrCreateWebDiscoverySource();

  // Tier 0: Broad climate discovery (searches web generally)
  const broadStats = await runBroadClimateDiscovery({
    fallbackSourceId,
    articleCap: broadArticleCap,
    freshHours: outletFreshHours,
  });

  // Tier 1-3: Outlet-specific discovery
  const outletStats = await runOutletDiscoverySegment({
    fallbackSourceId,
    limitPerBatch: outletLimitPerBatch,
    batchSize: outletBatchSize,
    articleCap: outletArticleCap,
    freshHours: outletFreshHours,
  });

  if (outletStats.queriesRun > 0) {
    console.log(
      `Curated outlet tier complete: ${outletStats.inserted} new articles from ${outletStats.scanned} results`,
    );
  } else {
    console.log(
      "Curated outlet tier skipped (no outlets configured or article cap set to 0)",
    );
  }

  const totalInserted = broadStats.inserted + outletStats.inserted;
  const totalScanned = broadStats.scanned + outletStats.scanned;
  const totalBrowseCost = broadStats.browseCost + outletStats.browseCost;
  const totalBrowseToolCalls = outletStats.browseToolCalls;
  const totalQueries = broadStats.queriesRun + outletStats.queriesRun;

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `Web discovery completed: ${totalInserted} new articles from ${totalScanned} results in ${duration}s`,
  );

  if (totalBrowseCost > 0) {
    console.log(
      `Estimated search spend: ~$${totalBrowseCost.toFixed(4)} ` +
        `(${TAVILY_ENABLED ? "Tavily + " : ""}OpenAI${totalBrowseToolCalls > 0 ? `, ${totalBrowseToolCalls} tool calls` : ""})`,
    );
  }

  if (opts.closePool) {
    await endPool();
  }

  return {
    totalInserted,
    totalScanned,
    duration,
    queriesRun: totalQueries,
    estimatedBrowseCost: totalBrowseCost,
    browseToolCalls: totalBrowseToolCalls,
  };
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
