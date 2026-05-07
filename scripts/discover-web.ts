// scripts/discover-web.ts
import { query, endPool } from "@/lib/db";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { tavily } from "@tavily/core";
import { categorizeAndStoreArticle } from "@/lib/categorizer";
import { isClimateRelevant } from "@/lib/tagger";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  CURATED_CLIMATE_OUTLETS,
  type ClimateOutlet,
} from "@/config/climateOutlets";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type PromptInputs,
} from "@/config/webSearchProfiles";
import { generateEmbedding, assignArticleToCluster } from "@/lib/clustering";
import {
  classifyArticleLanguageForIngest,
  type LanguageDetection,
} from "@/lib/language";
import { ENGLISH_LANGUAGE_PROMPT_CONSTRAINT } from "@/lib/languagePolicy";
import {
  canonical,
  cleanGoogleNewsTitle,
  isValidArticleDate,
  extractPublisherFromRssItem,
  parseEnvFloat,
  parseEnvInt,
  type ArticleDateValidation,
} from "@/lib/utils";

// Tavily client for cost-effective site-specific search
// Only initialize if API key exists (SDK throws on empty key)
const TAVILY_ENABLED = !!process.env.TAVILY_API_KEY;
const tavilyClient = TAVILY_ENABLED
  ? tavily({ apiKey: process.env.TAVILY_API_KEY! })
  : null;
const TAVILY_SEARCH_DEPTH = (process.env.TAVILY_SEARCH_DEPTH || "basic") as
  | "basic"
  | "advanced";
const TAVILY_COST_PER_SEARCH = parseEnvFloat(
  "TAVILY_COST_PER_SEARCH_USD",
  TAVILY_SEARCH_DEPTH === "basic"
    ? parseEnvFloat("TAVILY_BASIC_SEARCH_COST_USD", 0.008)
    : parseEnvFloat("TAVILY_ADVANCED_SEARCH_COST_USD", 0.016),
);

type DiscoveryProvider =
  | "tavily"
  | "openai_web_search"
  | "openai_google_suggestions"
  | "google_news_rss";

type DiscoverySegment = "broad" | "outlet" | "google_news";

type DiscoveryOutcomeReason =
  | "inserted"
  | "invalid_title"
  | "non_climate"
  | "non_english"
  | "duplicate_url"
  | "duplicate_title"
  | "duplicate_candidate"
  | "missing_date"
  | "stale"
  | "invalid_date"
  | "fabricated_url"
  | "aggregator_url"
  | "out_of_domain"
  | "unreachable"
  | "insert_failed"
  | "article_cap_reached";

type DiscoveryOutcome = {
  accepted: boolean;
  reason: DiscoveryOutcomeReason;
  articleId?: number;
  duplicateArticleId?: number;
};

export type WebSearchDiscoveryMeta = {
  provider?: DiscoveryProvider;
  query?: string;
  rank?: number;
  searchId?: number;
  candidateId?: number;
  raw?: unknown;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  source?: string;
  publisherHomepage?: string;
  discovery?: WebSearchDiscoveryMeta;
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
  segment?: DiscoverySegment;
};

const GOOGLE_SUGGESTION_MODEL =
  process.env.GOOGLE_SUGGESTION_MODEL || "gpt-4o-mini";
const GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS = parseEnvInt(
  "GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS",
  600,
);

const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== "0";
const WEB_SEARCH_MODEL = process.env.WEB_SEARCH_MODEL || "gpt-4.1-mini";
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
const WEB_SEARCH_FORCE_TOOL = process.env.WEB_SEARCH_FORCE_TOOL !== "0";
const WEB_SEARCH_DEBUG = process.env.WEB_SEARCH_DEBUG === "1";
const DISCOVERY_PAUSE_MS = 1000; // Reduced from 2000ms for faster processing
const DEFAULT_OUTLET_FRESHNESS_HOURS = 72; // Reduced from 96 for fresher content
const HOST_BLOCKLIST = new Set([
  "news.google.com",
  "news.yahoo.com",
  "msn.com",
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

/**
 * Detect URLs that look fabricated by LLMs — e.g. placeholder article IDs
 * like "-000000" or paths with long runs of zeros.
 */
export function isLikelyFabricatedUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    // Reject paths ending with a slug segment of all zeros (e.g. "-000000")
    if (/-0{4,}$/.test(pathname)) return true;
    // Reject paths where the last numeric segment is all zeros (e.g. "/00000000")
    if (/\/0{5,}(?:\/|$)/.test(pathname)) return true;
    return false;
  } catch {
    return false;
  }
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

const OPENAI_WEB_SEARCH_INPUT_PER_M = parseEnvFloat(
  "OPENAI_WEB_SEARCH_INPUT_PER_M",
  2.5,
);
const OPENAI_WEB_SEARCH_OUTPUT_PER_M = parseEnvFloat(
  "OPENAI_WEB_SEARCH_OUTPUT_PER_M",
  10,
);
const OPENAI_WEB_SEARCH_TOOL_CALL_COST = parseEnvFloat(
  "OPENAI_WEB_SEARCH_TOOL_CALL_COST_USD",
  0.01,
);

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

type ProviderRunStats = {
  searches: number;
  candidates: number;
  inserted: number;
  rejected: number;
  estimatedCost: number;
  toolCalls: number;
  latencyMs: number;
};

type DiscoverySearchLog = {
  provider: DiscoveryProvider;
  segment: DiscoverySegment;
  searchQuery: string;
  requestedDomains?: string[];
  model?: string;
  searchDepth?: string;
  toolCalls?: number;
  resultCount: number;
  costUsd?: number;
  latencyMs?: number;
  status: "success" | "error";
  errorMsg?: string;
};

class DiscoveryTelemetry {
  readonly runId = randomUUID();
  telemetryReady = false;
  telemetryUnavailable = false;
  providerRunStats = new Map<DiscoveryProvider, ProviderRunStats>();
}

const fallbackDiscoveryTelemetry = new DiscoveryTelemetry();
const discoveryTelemetryScope = new AsyncLocalStorage<DiscoveryTelemetry>();

function currentDiscoveryTelemetry(): DiscoveryTelemetry {
  return discoveryTelemetryScope.getStore() ?? fallbackDiscoveryTelemetry;
}

function getProviderStats(provider: DiscoveryProvider): ProviderRunStats {
  const statsByProvider = currentDiscoveryTelemetry().providerRunStats;
  const existing = statsByProvider.get(provider);
  if (existing) return existing;

  const initialized: ProviderRunStats = {
    searches: 0,
    candidates: 0,
    inserted: 0,
    rejected: 0,
    estimatedCost: 0,
    toolCalls: 0,
    latencyMs: 0,
  };
  statsByProvider.set(provider, initialized);
  return initialized;
}

function recordSearchStats(log: DiscoverySearchLog) {
  const stats = getProviderStats(log.provider);
  stats.searches += 1;
  stats.candidates += log.resultCount;
  stats.estimatedCost += log.costUsd ?? 0;
  stats.toolCalls += log.toolCalls ?? 0;
  stats.latencyMs += log.latencyMs ?? 0;
}

function recordOutcomeStats(
  result: WebSearchResult,
  outcome: DiscoveryOutcome,
) {
  if (!result.discovery?.provider) return;
  const stats = getProviderStats(result.discovery.provider);
  if (outcome.accepted) {
    stats.inserted += 1;
  } else {
    stats.rejected += 1;
  }
}

function summarizeProviderStats() {
  const statsByProvider = currentDiscoveryTelemetry().providerRunStats;
  return Object.fromEntries(
    [...statsByProvider.entries()].map(([provider, stats]) => [
      provider,
      {
        searches: stats.searches,
        candidates: stats.candidates,
        inserted: stats.inserted,
        rejected: stats.rejected,
        estimatedCost: Number(stats.estimatedCost.toFixed(6)),
        toolCalls: stats.toolCalls,
        latencyMs: stats.latencyMs,
      },
    ]),
  );
}

async function ensureDiscoveryTelemetryTables(): Promise<boolean> {
  const telemetry = currentDiscoveryTelemetry();
  if (telemetry.telemetryReady) return true;
  if (telemetry.telemetryUnavailable) return false;

  try {
    const { rows } = await query<{
      searches: string | null;
      candidates: string | null;
    }>(`
      SELECT
        to_regclass('public.discovery_searches')::text AS searches,
        to_regclass('public.discovery_candidates')::text AS candidates
    `);
    const ready = Boolean(rows[0]?.searches && rows[0]?.candidates);
    telemetry.telemetryReady = ready;
    telemetry.telemetryUnavailable = !ready;
    if (!ready) {
      console.warn(
        "Discovery telemetry tables are missing; run `bun run schema` to enable logging.",
      );
    }
    return ready;
  } catch (error) {
    telemetry.telemetryUnavailable = true;
    console.error("Failed to check discovery telemetry tables:", error);
    return false;
  }
}

function safeJsonValue(value: unknown): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { serializationError: true };
  }
}

type SearchTelemetryMeta = Pick<
  DiscoverySearchLog,
  | "provider"
  | "segment"
  | "searchQuery"
  | "requestedDomains"
  | "model"
  | "searchDepth"
>;

type SearchOutcome =
  | {
      status: "success";
      resultCount: number;
      toolCalls?: number;
      costUsd?: number;
    }
  | { status: "error"; error: unknown };

/**
 * Single entry point for the success/error dance every provider call repeats:
 * stamps latency, normalizes the error message, and forwards to logDiscoverySearch.
 */
async function logSearchOutcome(
  meta: SearchTelemetryMeta,
  startedAt: number,
  outcome: SearchOutcome,
): Promise<number | null> {
  const latencyMs = Date.now() - startedAt;
  if (outcome.status === "success") {
    return logDiscoverySearch({
      ...meta,
      status: "success",
      resultCount: outcome.resultCount,
      toolCalls: outcome.toolCalls,
      costUsd: outcome.costUsd,
      latencyMs,
    });
  }
  return logDiscoverySearch({
    ...meta,
    status: "error",
    resultCount: 0,
    costUsd: 0,
    latencyMs,
    errorMsg:
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error),
  });
}

async function logDiscoverySearch(
  log: DiscoverySearchLog,
): Promise<number | null> {
  recordSearchStats(log);

  if (!(await ensureDiscoveryTelemetryTables())) {
    return null;
  }

  try {
    const { rows } = await query<{ id: number }>(
      `
      INSERT INTO discovery_searches (
        run_id,
        provider,
        segment,
        query,
        requested_domains,
        model,
        search_depth,
        tool_calls,
        result_count,
        cost_usd,
        latency_ms,
        status,
        error_msg
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `,
      [
        currentDiscoveryTelemetry().runId,
        log.provider,
        log.segment,
        log.searchQuery,
        log.requestedDomains ?? null,
        log.model ?? null,
        log.searchDepth ?? null,
        log.toolCalls ?? 0,
        log.resultCount,
        log.costUsd ?? null,
        log.latencyMs ?? null,
        log.status,
        log.errorMsg ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    console.error("Failed to log discovery search:", error);
    return null;
  }
}

async function attachDiscoveryCandidates(
  results: WebSearchResult[],
  params: {
    provider: DiscoveryProvider;
    searchId: number | null;
    searchQuery: string;
  },
): Promise<WebSearchResult[]> {
  const annotated = results.map(
    (result, index): WebSearchResult => ({
      ...result,
      discovery: {
        ...(result.discovery ?? {}),
        provider: params.provider,
        searchId: params.searchId ?? undefined,
        query: params.searchQuery,
        rank: index + 1,
      },
    }),
  );

  if (!params.searchId || !(await ensureDiscoveryTelemetryTables())) {
    return annotated;
  }

  try {
    const payload = annotated.map((result) => {
      const canonicalUrl = canonical(extractRealUrl(result.url));
      return {
        rank: result.discovery?.rank ?? null,
        title: result.title,
        url: result.url,
        canonical_url: canonicalUrl,
        host: hostFromUrl(canonicalUrl),
        published_at: normalizePublishedDate(result.publishedDate),
        raw_published_at: result.publishedDate ?? null,
        source_name: result.source ?? null,
        snippet: result.snippet ?? null,
        raw: safeJsonValue(result.discovery?.raw),
      };
    });

    const { rows } = await query<{ id: number; rank: number }>(
      `
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          rank int,
          title text,
          url text,
          canonical_url text,
          host text,
          published_at timestamptz,
          raw_published_at text,
          source_name text,
          snippet text,
          raw jsonb
        )
      )
        INSERT INTO discovery_candidates (
          discovery_search_id,
          provider,
          rank,
          title,
          url,
          canonical_url,
          host,
          published_at,
          raw_published_at,
          source_name,
          snippet,
          raw
        )
        SELECT
          $2,
          $3,
          rank,
          title,
          url,
          canonical_url,
          host,
          published_at,
          raw_published_at,
          source_name,
          snippet,
          raw
        FROM payload
        RETURNING id, rank
      `,
      [JSON.stringify(payload), params.searchId, params.provider],
    );

    const idsByRank = new Map(rows.map((row) => [row.rank, row.id]));
    return annotated.map((result): WebSearchResult => {
      const rank = result.discovery?.rank;
      return {
        ...result,
        discovery: {
          ...(result.discovery ?? {}),
          candidateId: rank == null ? undefined : idsByRank.get(rank),
        },
      };
    });
  } catch (error) {
    console.error("Failed to log discovery candidates:", error);
    return annotated;
  }
}

type CandidateOutcomeRecord = {
  result: WebSearchResult;
  outcome: DiscoveryOutcome;
};

async function recordDiscoveryCandidateOutcomes(
  records: CandidateOutcomeRecord[],
) {
  for (const { result, outcome } of records) {
    recordOutcomeStats(result, outcome);
  }

  const updates = records
    .filter(({ result }) => result.discovery?.candidateId)
    .map(({ result, outcome }) => ({
      id: result.discovery!.candidateId!,
      accepted: outcome.accepted,
      rejection_reason: outcome.accepted ? null : outcome.reason,
      article_id: outcome.articleId ?? null,
      duplicate_article_id: outcome.duplicateArticleId ?? null,
    }));

  if (updates.length === 0 || !(await ensureDiscoveryTelemetryTables())) {
    return;
  }

  try {
    await query(
      `
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          id bigint,
          accepted boolean,
          rejection_reason text,
          article_id bigint,
          duplicate_article_id bigint
        )
      )
      UPDATE discovery_candidates c
      SET accepted = payload.accepted,
          rejection_reason = payload.rejection_reason,
          article_id = payload.article_id,
          duplicate_article_id = payload.duplicate_article_id
      FROM payload
      WHERE c.id = payload.id
    `,
      [JSON.stringify(updates)],
    );
  } catch (error) {
    console.error("Failed to update discovery candidate outcomes:", error);
  }
}

function dedupeWebResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const urlKey = result.url ? canonical(result.url).toLowerCase() : "";
    const titleKey = result.title ? result.title.trim().toLowerCase() : "";
    const key = urlKey || titleKey;
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function dedupeWebResultsForProcessing(
  results: WebSearchResult[],
): Promise<WebSearchResult[]> {
  const seen = new Set<string>();
  const deduped: WebSearchResult[] = [];
  const duplicateOutcomes: CandidateOutcomeRecord[] = [];

  for (const result of results) {
    const urlKey = result.url ? canonical(result.url).toLowerCase() : "";
    const titleKey = result.title ? result.title.trim().toLowerCase() : "";
    const key = urlKey || titleKey;
    if (!key) continue;

    if (seen.has(key)) {
      duplicateOutcomes.push({
        result,
        outcome: {
          accepted: false,
          reason: "duplicate_candidate",
        },
      });
      continue;
    }

    seen.add(key);
    deduped.push(result);
  }

  await recordDiscoveryCandidateOutcomes(duplicateOutcomes);

  return deduped;
}

async function markUnprocessedCandidates(
  results: WebSearchResult[],
  reason: DiscoveryOutcomeReason,
) {
  await recordDiscoveryCandidateOutcomes(
    results.map((result) => ({
      result,
      outcome: {
        accepted: false,
        reason,
      },
    })),
  );
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

const COMPOUND_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "org.au",
  "co.nz",
  "org.in",
  "co.in",
  "co.za",
  "com.br",
  "co.jp",
]);

/** Extract registrable root domain: "assets.canarymedia.com" → "canarymedia.com" */
export function rootDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (COMPOUND_TLDS.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

// Common TLDs and country codes to strip when humanizing hostnames
const COMMON_TLDS = new Set([
  // Generic TLDs
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "io",
  "co",
  "info",
  "biz",
  // Country codes
  "us",
  "uk",
  "ca",
  "au",
  "de",
  "fr",
  "nz",
  "ie",
  "in",
  "pk",
  "sg",
  "hk",
  "za",
  "my",
  "ph",
  "br",
  "mx",
  "jp",
  "kr",
  "cn",
  "tw",
  "th",
  "vn",
  "id",
  "ae",
  "sa",
  "il",
  "eg",
  "ng",
  "ke",
  "gh",
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

/**
 * Drop results whose hostname was never cited by the web search tool's sources.
 * This catches hallucinated URLs where the model fabricates links for domains
 * the tool never actually visited.
 */
export function filterUncitedResults(
  results: WebSearchResult[],
  sources: Array<{ url?: string }>,
): WebSearchResult[] {
  if (sources.length === 0) return results;

  const citedHosts = new Set<string>();
  for (const src of sources) {
    if (src && typeof src.url === "string") {
      try {
        const u = new URL(src.url);
        citedHosts.add(u.hostname.replace(/^www\./, ""));
      } catch {
        // skip malformed source URLs
      }
    }
  }

  if (citedHosts.size === 0) return results;

  const beforeCount = results.length;
  const filtered = results.filter((result) => {
    try {
      const u = new URL(result.url);
      const host = u.hostname.replace(/^www\./, "");
      if (citedHosts.has(host)) return true;
      console.log(
        `⚠️  Dropped result with URL not cited in web search sources: ${result.url}`,
      );
      return false;
    } catch {
      return false;
    }
  });

  if (beforeCount !== filtered.length) {
    console.log(
      `Source cross-validation dropped ${beforeCount - filtered.length} uncited results`,
    );
  }

  return filtered;
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

export function parseWebSearchJson(
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

      // Reject URLs with placeholder/fabricated patterns (LLM hallucination)
      if (isLikelyFabricatedUrl(url)) {
        console.log(
          `⚠️  Rejected likely fabricated URL: ${url} ("${title.substring(0, 60)}...")`,
        );
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

  const startedAt = Date.now();
  const segment = overrides?.segment ?? "outlet";
  const requestedLimit = overrides?.resultLimit ?? WEB_SEARCH_RESULT_LIMIT;
  const allowedDomains =
    overrides?.allowedDomains && overrides.allowedDomains.length > 0
      ? overrides.allowedDomains
      : WEB_SEARCH_ALLOWED_DOMAINS;

  try {
    console.log(`🔎 OpenAI web search: ${query}`);

    const systemMessage =
      overrides?.systemPrompt ??
      `You are ClimateRiver's climate desk scout. Use the web search tool to find recent climate articles.

CRITICAL: Your response MUST be ONLY a valid JSON array. No text before or after.

Required format:
[{"title":"Article Title","url":"https://...","snippet":"Brief summary","publishedDate":"${new Date().toISOString().split("T")[0]}T12:00:00Z","source":"Outlet Name"}]

Rules:
- Only include articles from the past 72 hours
- Only include articles from the specified domains
- Only include ${ENGLISH_LANGUAGE_PROMPT_CONSTRAINT} articles
- Reject aggregator URLs (news.google.com, yahoo, msn)
- Each item MUST have: title, url, snippet, publishedDate (ISO 8601), source
- Sort newest to oldest
- If no articles found, return empty array: []`;
    const userMessage =
      overrides?.userPrompt ??
      `Find up to ${requestedLimit} vetted ${ENGLISH_LANGUAGE_PROMPT_CONSTRAINT} climate or environment-related articles for: "${query}". Require publish dates within the past 72 hours, prioritize investigative/policy/science/finance impact, and ensure each entry includes a trustworthy ISO timestamp. If fewer than ${requestedLimit} items qualify, only return the smaller set. Sort newest to oldest before responding.`;

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
          ...(allowedDomains && allowedDomains.length > 0
            ? { filters: { allowedDomains } }
            : {}),
        }),
      },
      toolChoice: WEB_SEARCH_FORCE_TOOL
        ? { type: "tool", toolName: "webSearch" }
        : "auto",
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

    // Cross-validate model-claimed URLs against tool-cited sources.
    if (Array.isArray(response.sources) && response.sources.length > 0) {
      results = filterUncitedResults(
        results,
        response.sources as Array<{ url?: string }>,
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

    const meta: SearchTelemetryMeta = {
      provider: "openai_web_search",
      segment,
      searchQuery: query,
      requestedDomains: allowedDomains,
      model: WEB_SEARCH_MODEL,
    };
    const searchId = await logSearchOutcome(meta, startedAt, {
      status: "success",
      resultCount: results.length,
      toolCalls,
      costUsd: estimatedCost,
    });
    results = await attachDiscoveryCandidates(results, {
      provider: "openai_web_search",
      searchId,
      searchQuery: query,
    });

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
    await logSearchOutcome(
      {
        provider: "openai_web_search",
        segment,
        searchQuery: query,
        requestedDomains: allowedDomains,
        model: WEB_SEARCH_MODEL,
      },
      startedAt,
      { status: "error", error },
    );
    return { results: [], stats: { estimatedCost: 0, toolCalls: 0 } };
  }
}

// Tavily search - 20x cheaper than OpenAI for site-specific searches
async function searchViaTavily(
  domain: string,
  maxResults = 5,
  segment: DiscoverySegment = "outlet",
): Promise<{ results: WebSearchResult[]; cost: number }> {
  if (!TAVILY_ENABLED) {
    return { results: [], cost: 0 };
  }

  const searchQuery = `site:${domain} climate energy environment`;
  const startedAt = Date.now();

  try {
    console.log(`🔍 Tavily search: site:${domain} climate`);

    // Tavily SDK: search(query: string, options?: TavilySearchOptions)
    // tavilyClient is guaranteed non-null here because TAVILY_ENABLED check above
    const response = await tavilyClient!.search(searchQuery, {
      searchDepth: TAVILY_SEARCH_DEPTH,
      includeAnswer: false,
      maxResults,
      includeDomains: [domain], // Use native domain filtering
      topic: "news", // Focus on news articles
      days: 7, // Last 7 days
    });

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
        discovery: { raw: r },
      }));

    console.log(
      `  Tavily returned ${results.length} results (~$${TAVILY_COST_PER_SEARCH.toFixed(4)})`,
    );

    const meta: SearchTelemetryMeta = {
      provider: "tavily",
      segment,
      searchQuery,
      requestedDomains: [domain],
      searchDepth: TAVILY_SEARCH_DEPTH,
    };
    const searchId = await logSearchOutcome(meta, startedAt, {
      status: "success",
      resultCount: results.length,
      costUsd: TAVILY_COST_PER_SEARCH,
    });

    return {
      results: await attachDiscoveryCandidates(results, {
        provider: "tavily",
        searchId,
        searchQuery,
      }),
      cost: TAVILY_COST_PER_SEARCH,
    };
  } catch (error) {
    console.error(`Tavily search error for ${domain}:`, error);
    await logSearchOutcome(
      {
        provider: "tavily",
        segment,
        searchQuery,
        requestedDomains: [domain],
        searchDepth: TAVILY_SEARCH_DEPTH,
      },
      startedAt,
      { status: "error", error },
    );
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

  return {
    results: await dedupeWebResultsForProcessing(allResults),
    totalCost,
  };
}

async function discoverViaGoogleNews(
  query: string,
  allowedDomains: string[] = [],
): Promise<WebSearchResult[]> {
  const suggestionText = await generateGoogleNewsSuggestions(
    query,
    allowedDomains,
  );
  const suggestionResults = await executeAISearchSuggestions(suggestionText);

  if (suggestionResults.length > 0) {
    return suggestionResults;
  }

  console.log(
    "AI suggestions empty, falling back to direct Google News search",
  );
  return await searchGoogleNewsRSS(
    buildGoogleNewsFallbackQuery(query, allowedDomains),
  );
}

async function generateGoogleNewsSuggestions(
  query: string,
  allowedDomains: string[] = [],
): Promise<string | null> {
  console.log(`OpenAI Google News suggestions: ${query}`);
  const startedAt = Date.now();
  const domainInstruction =
    allowedDomains.length > 0
      ? ` Every searchTerm must include a site: filter for at least one of these allowed domains: ${allowedDomains.join(", ")}.`
      : "";

  try {
    const { text } = await generateText({
      model: openai(GOOGLE_SUGGESTION_MODEL),
      messages: [
        {
          role: "system",
          content: `You build advanced Google News RSS queries for climate reporting. Return only a JSON array. Each element must contain "searchTerm" (Google News-ready string), "reasoning" (short justification), and "expectedSources" (array). Every searchTerm must use boolean operators and/or quoted phrases, include a recency constraint such as when:1d/when:3d, and when helpful reference curated climate outlets (e.g., ${GOOGLE_SUGGESTION_OUTLET_EXAMPLES}) via site:domain or source keywords.${domainInstruction} Avoid generic requests like "climate change news". No prose outside the JSON.`,
        },
        {
          role: "user",
          content: `Provide 2-4 advanced Google News search strings to surface fresh ${ENGLISH_LANGUAGE_PROMPT_CONSTRAINT} climate or environment coverage for: "${query}". Combine climate subtopics (policy, finance, science, justice) with geography or sector cues, apply recency filters (e.g., when:1d), and bias toward reputable climate outlets.${allowedDomains.length > 0 ? ` Only target these domains: ${allowedDomains.join(", ")}.` : ""} Avoid generic or repetitive phrases.`,
        },
      ],
      maxOutputTokens: GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS,
    });

    const meta: SearchTelemetryMeta = {
      provider: "openai_google_suggestions",
      segment: "google_news",
      searchQuery: query,
      model: GOOGLE_SUGGESTION_MODEL,
    };
    await logSearchOutcome(meta, startedAt, {
      status: "success",
      resultCount: countGoogleSuggestionTerms(text),
    });

    return text ?? null;
  } catch (error) {
    console.error("Error generating Google News suggestions:", error);
    await logSearchOutcome(
      {
        provider: "openai_google_suggestions",
        segment: "google_news",
        searchQuery: query,
        model: GOOGLE_SUGGESTION_MODEL,
      },
      startedAt,
      { status: "error", error },
    );
    return null;
  }
}

function buildGoogleNewsFallbackQuery(
  query: string,
  allowedDomains: string[],
): string {
  if (allowedDomains.length === 0) return query;
  const domainClause = allowedDomains
    .map((domain) => `site:${domain}`)
    .join(" OR ");
  return `(${domainClause}) (climate OR energy OR environment) when:3d`;
}

function countGoogleSuggestionTerms(
  content: string | null | undefined,
): number {
  if (!content) return 0;
  try {
    const suggestions = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    return Array.isArray(suggestions) ? suggestions.length : 0;
  } catch {
    return 0;
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
  const startedAt = Date.now();
  // Import RSS parser
  const Parser = (await import("rss-parser")).default;
  const parser = new Parser({
    headers: {
      "User-Agent": "ClimateRiverBot/0.1 (+https://climateriver.org)",
    },
    requestOptions: { timeout: 10000 },
    customFields: {
      item: [["source", "source", { keepArray: true }]],
    },
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
      if (hostFromUrl(realUrl) === "news.google.com") {
        console.warn(`⚠️  Failed to resolve Google News URL: ${item.link}`);
      }

      // Extract publisher from RSS <source> element (same as ingest pipeline)
      const publisher = extractPublisherFromRssItem(item);

      results.push({
        title: cleanGoogleNewsTitle(item.title),
        url: realUrl,
        snippet: item.contentSnippet || item.content || "",
        publishedDate: item.isoDate || item.pubDate,
        source: publisher.name || extractSourceFromUrl(realUrl),
        publisherHomepage: publisher.homepage,
      });
    }

    const meta: SearchTelemetryMeta = {
      provider: "google_news_rss",
      segment: "google_news",
      searchQuery: query,
    };
    const searchId = await logSearchOutcome(meta, startedAt, {
      status: "success",
      resultCount: results.length,
    });

    return await attachDiscoveryCandidates(results, {
      provider: "google_news_rss",
      searchId,
      searchQuery: query,
    });
  } catch (error) {
    console.error(`Error searching Google News for "${query}":`, error);
    await logSearchOutcome(
      {
        provider: "google_news_rss",
        segment: "google_news",
        searchQuery: query,
      },
      startedAt,
      { status: "error", error },
    );
    return [];
  }
}

export function extractRealUrl(googleUrl: string): string {
  try {
    const url = new URL(googleUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "news.google.com") {
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

export function resolveGoogleNewsCandidate(
  candidate: string | undefined,
): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("http")) {
    return canonical(trimmed);
  }

  const decoded = maybeDecodeBase64Url(trimmed);
  if (decoded?.startsWith("http")) {
    return canonical(decoded);
  }

  return null;
}

export function maybeDecodeBase64Url(value: string): string | null {
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

function normalizePublishedDate(
  value: string | Date | null | undefined,
): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

async function findDuplicate(
  title: string,
  url: string,
): Promise<
  | {
      duplicate: false;
    }
  | {
      duplicate: true;
      reason: "duplicate_url" | "duplicate_title";
      articleId: number;
    }
> {
  // Check if we already have this article by URL
  const existingByUrl = await query<{ id: number }>(
    "SELECT id FROM articles WHERE canonical_url = $1",
    [url],
  );

  if (existingByUrl.rows.length > 0) {
    return {
      duplicate: true,
      reason: "duplicate_url",
      articleId: existingByUrl.rows[0].id,
    };
  }

  // Check for similar title (basic duplicate detection)
  const normalizedTitle = title.trim().toLowerCase();

  if (normalizedTitle) {
    const existingByTitle = await query<{ id: number }>(
      "SELECT id FROM articles WHERE LOWER(title) = $1 AND fetched_at > NOW() - INTERVAL '48 hours'",
      [normalizedTitle],
    );

    if (existingByTitle.rows.length > 0) {
      return {
        duplicate: true,
        reason: "duplicate_title",
        articleId: existingByTitle.rows[0].id,
      };
    }
  }

  return { duplicate: false };
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
    const sourceName = result.source?.trim();
    const pubHost = result.publisherHomepage
      ? hostFromUrl(result.publisherHomepage)
      : null;

    // If we have a real publisher homepage (e.g. from RSS <source> element),
    // resolve the source using that host instead of the blocklisted URL
    if (pubHost && !HOST_BLOCKLIST.has(pubHost)) {
      // Recurse with a synthetic result pointing to the publisher homepage
      return getOrCreateSourceForResult(
        {
          ...result,
          url: result.publisherHomepage!,
          publisherHomepage: undefined,
        },
        fallbackSourceId,
      );
    }

    return {
      sourceId: fallbackSourceId,
      publisherName:
        sourceName && !looksLikeDomain(sourceName) ? sourceName : null,
      publisherHomepage: result.publisherHomepage ?? null,
    };
  }

  const homepage = `https://${host}`;

  // Check in-memory cache first to avoid DB round-trip
  const root = rootDomain(host);
  const cached = sourceCache.get(host) ?? sourceCache.get(root);
  if (cached) {
    return {
      sourceId: cached,
      publisherName: null,
      publisherHomepage: homepage,
    };
  }

  const slug = slugifyHost(host);
  const feedUrl = `web://${host}`;
  const rootSlug = slugifyHost(root);
  const rootFeedUrl = `web://${root}`;

  // Check if we already have this source (also match root domain to prevent
  // subdomain duplicates like assets.canarymedia.com vs www.canarymedia.com)
  const existing = await query<{ id: number; name: string }>(
    `
      SELECT id, name
      FROM sources
      WHERE slug = $1
         OR feed_url = $2
         OR lower(coalesce(homepage_url, '')) LIKE $3
         OR slug = $4
         OR feed_url = $5
         OR lower(coalesce(homepage_url, '')) LIKE $6
      ORDER BY weight DESC
      LIMIT 1
    `,
    [slug, feedUrl, `%${host}%`, rootSlug, rootFeedUrl, `%${root}%`],
  );

  if (existing.rows[0]) {
    const sourceId = existing.rows[0].id;
    sourceCache.set(host, sourceId);
    sourceCache.set(root, sourceId);

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

  // Default weight of 4 for web-discovered sources (lower than curated RSS sources)
  // This prevents random/low-quality sites from ranking as high as major outlets.
  // Scale is 1–10; see config/sourceTiers.ts.
  const DEFAULT_WEB_DISCOVERED_WEIGHT = 4;

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
  sourceCache.set(root, sourceId);

  // New source was just created with publisherName, so set it on the article too
  return {
    sourceId,
    publisherName,
    publisherHomepage: homepage,
  };
}

/**
 * Verify a URL is reachable via HEAD request before inserting.
 * Returns true if the URL appears valid (2xx/3xx), false if definitely dead (404/410).
 * On timeout or ambiguous errors (403, network issues), returns true (benefit of the doubt).
 */
async function isUrlReachable(url: string): Promise<boolean> {
  // Defense-in-depth: aggregator URLs should be caught by the blocklist guard
  // in tryInsertDiscoveredArticle. If one reaches here, log and reject.
  const reachHost = hostFromUrl(url);
  if (reachHost && HOST_BLOCKLIST.has(reachHost)) {
    console.warn(
      `⚠️  Aggregator URL reached reachability check (should have been caught earlier): ${url}`,
    );
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ClimateRiver/1.0; +https://climateriver.org)",
        Accept: "text/html",
      },
    });
    clearTimeout(timeout);

    if (response.status === 404 || response.status === 410) {
      return false;
    }
    return true;
  } catch {
    // Network error or timeout — give benefit of the doubt
    return true;
  }
}

async function insertWebDiscoveredArticle(
  result: WebSearchResult,
  sourceId: number,
  publishedDate: Date,
  publisherName?: string | null,
  publisherHomepage?: string | null,
  language?: LanguageDetection,
): Promise<number | null> {
  try {
    // Generate embedding for semantic clustering
    const embedding = await generateEmbedding(
      result.title,
      result.snippet ?? undefined,
    );

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
        publisher_homepage,
        embedding,
        language_code,
        language_confidence,
        language_raw_code,
        language_source,
        language_checked_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (canonical_url) DO NOTHING
      RETURNING id
    `,
      [
        sourceId,
        result.title,
        result.url,
        result.snippet,
        publishedDate,
        publisherName ?? null,
        publisherHomepage ?? null,
        embedding.length > 0 ? JSON.stringify(embedding) : null,
        language?.languageCode ?? null,
        language?.languageConfidence ?? null,
        language?.languageRawCode ?? null,
        language?.languageSource ?? null,
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
      8, // High weight for curated discoveries (scale 1–10)
      "web-discovery",
    ],
  );

  return rows[0].id;
}

type DiscoverySegmentStats = {
  inserted: number;
  scanned: number;
  queriesRun: number;
  browseCost: number;
  browseToolCalls: number;
  duration: number;
};

function dateValidationOutcomeReason(
  validation: ArticleDateValidation,
): DiscoveryOutcomeReason {
  if (validation.valid) return "inserted";
  if (validation.code === "missing_date") return "missing_date";
  if (validation.code === "too_old") return "stale";
  return "invalid_date";
}

function freshnessOutcomeReason(
  result: WebSearchResult,
  cutoffMs: number,
): DiscoveryOutcomeReason | null {
  const publishedAt = normalizePublishedDate(result.publishedDate);
  if (!publishedAt) return "missing_date";
  if (publishedAt.getTime() < cutoffMs) return "stale";
  return null;
}

async function tryInsertDiscoveredArticle(
  result: WebSearchResult,
  fallbackSourceId: number,
): Promise<DiscoveryOutcome> {
  if (!isValidHeadlineTitle(result.title)) {
    return { accepted: false, reason: "invalid_title" };
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
    return { accepted: false, reason: "non_climate" };
  }

  // Match ingest pipeline normalization
  result = { ...result, url: canonical(extractRealUrl(result.url)) };

  // Reject URLs still pointing at aggregator hosts after resolution
  const normalizedHost = hostFromUrl(result.url);
  if (normalizedHost && HOST_BLOCKLIST.has(normalizedHost)) {
    console.warn(
      `⚠️  Skipping unresolved aggregator URL (${normalizedHost}): ${result.title.substring(0, 60)}...`,
    );
    return { accepted: false, reason: "aggregator_url" };
  }

  if (isLikelyFabricatedUrl(result.url)) {
    console.log(`⚠️  Skipping article with fabricated URL: ${result.url}`);
    return { accepted: false, reason: "fabricated_url" };
  }

  const publishedAt = normalizePublishedDate(result.publishedDate);
  const dateValidation = isValidArticleDate(publishedAt, 7);
  if (!dateValidation.valid) {
    console.log(
      `⚠️  Skipping web-discovered article with invalid date (${dateValidation.reason}): "${result.title.substring(0, 60)}..."`,
    );
    return {
      accepted: false,
      reason: dateValidationOutcomeReason(dateValidation),
    };
  }

  const languageGate = classifyArticleLanguageForIngest(
    result.title,
    result.snippet ?? null,
  );
  if (languageGate.skip) {
    const host = hostFromUrl(result.url) || result.source || "unknown source";
    console.log(
      `- Skipped non-English result (${languageGate.language.languageCode}) from ${host}: ${result.title.substring(0, 80)}`,
    );
    return { accepted: false, reason: "non_english" };
  }
  const { language } = languageGate;

  const reachable = await isUrlReachable(result.url);
  if (!reachable) {
    console.log(
      `⚠️  Skipping unreachable URL (404/410): ${result.url} ("${result.title.substring(0, 60)}...")`,
    );
    return { accepted: false, reason: "unreachable" };
  }

  const duplicate = await findDuplicate(result.title, result.url);

  if (duplicate.duplicate) {
    console.log(`- Skipped duplicate: ${result.title.substring(0, 60)}...`);
    return {
      accepted: false,
      reason: duplicate.reason,
      duplicateArticleId: duplicate.articleId,
    };
  }

  const { sourceId, publisherName, publisherHomepage } =
    await getOrCreateSourceForResult(result, fallbackSourceId);

  const articleId = await insertWebDiscoveredArticle(
    result,
    sourceId,
    publishedAt!,
    publisherName,
    publisherHomepage,
    language,
  );

  if (!articleId) {
    return { accepted: false, reason: "insert_failed" };
  }

  await assignArticleToCluster(articleId, result.title);

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

  return { accepted: true, reason: "inserted", articleId };
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

      const promptInputs: PromptInputs = {
        freshHours,
        domains: missingDomains,
        descriptors: missingDescriptors,
        resultLimit: limitPerBatch,
      };
      const targetedSystemPrompt = buildSystemPrompt("v4", promptInputs);
      const targetedUserPrompt = buildUserPrompt("v4", promptInputs);

      const fallbackQuery = `Latest climate coverage across: ${missingDomains.join(", ")}`;
      const { results: openAIResults, stats: browseStats } =
        await callOpenAIWebSearch(fallbackQuery, {
          systemPrompt: targetedSystemPrompt,
          userPrompt: targetedUserPrompt,
          allowedDomains: missingDomains,
          resultLimit: limitPerBatch,
          segment: "outlet",
        });

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

      const stillMissingAfterOpenAI = missingDomainEntries.filter(
        (entry) => (domainHitCounts.get(entry.normalized) ?? 0) === 0,
      );

      if (stillMissingAfterOpenAI.length > 0) {
        const googleDomains = stillMissingAfterOpenAI.map((entry) => entry.raw);
        console.log(
          `  → Tier 3: Google News fallback for ${googleDomains.length} domains: ${stillMissingAfterOpenAI
            .map((entry) => entry.outlet.name)
            .join(", ")}`,
        );

        const googleResults = await discoverViaGoogleNews(
          `Latest climate coverage across: ${googleDomains.join(", ")}`,
          googleDomains,
        );
        queriesRun++;
        const domainFilteredGoogleResults = googleResults.filter((result) =>
          isAllowedDomain(result.url, googleDomains),
        );
        const outOfDomainGoogleResults = googleResults.filter(
          (result) => !isAllowedDomain(result.url, googleDomains),
        );
        if (outOfDomainGoogleResults.length > 0) {
          console.log(
            `  Dropped ${outOfDomainGoogleResults.length} Google News results outside fallback domains`,
          );
          await recordDiscoveryCandidateOutcomes(
            outOfDomainGoogleResults.map((result) => ({
              result,
              outcome: {
                accepted: false,
                reason: "out_of_domain",
              },
            })),
          );
        }
        batchResults.push(...domainFilteredGoogleResults);

        updateDomainHitCounts(
          domainHitCounts,
          domainFilteredGoogleResults,
          stillMissingAfterOpenAI.map((entry) => entry.normalized),
        );
      }
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

    // Dedupe before processing while preserving provider-level duplicate telemetry.
    batchResults = await dedupeWebResultsForProcessing(batchResults);
    scanned += batchResults.length;

    const outcomeRecords: CandidateOutcomeRecord[] = [];
    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      if (inserted >= articleCap) {
        await markUnprocessedCandidates(
          batchResults.slice(i),
          "article_cap_reached",
        );
        break;
      }
      const freshnessReason = freshnessCutoffMs
        ? freshnessOutcomeReason(result, freshnessCutoffMs)
        : null;
      if (freshnessReason) {
        console.log(
          `- Skipped stale (${result.publishedDate ?? "unknown"}): ${result.title.substring(0, 80)}`,
        );
        outcomeRecords.push({
          result,
          outcome: {
            accepted: false,
            reason: freshnessReason,
          },
        });
        continue;
      }
      const outcome = await tryInsertDiscoveredArticle(
        result,
        fallbackSourceId,
      );
      outcomeRecords.push({ result, outcome });
      if (outcome.accepted) {
        inserted++;
      }
    }
    await recordDiscoveryCandidateOutcomes(outcomeRecords);

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
  const currentYear = new Date().getFullYear();
  const broadQueries = [
    `climate change policy legislation ${currentYear}`,
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

    const searchStartedAt = Date.now();
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
          discovery: { raw: r },
        }));

      const meta: SearchTelemetryMeta = {
        provider: "tavily",
        segment: "broad",
        searchQuery,
        searchDepth: TAVILY_SEARCH_DEPTH,
      };
      const searchId = await logSearchOutcome(meta, searchStartedAt, {
        status: "success",
        resultCount: results.length,
        costUsd: TAVILY_COST_PER_SEARCH,
      });
      const annotatedResults = await attachDiscoveryCandidates(results, {
        provider: "tavily",
        searchId,
        searchQuery,
      });

      scanned += annotatedResults.length;
      console.log(`    Found ${annotatedResults.length} results`);

      const outcomeRecords: CandidateOutcomeRecord[] = [];
      for (let i = 0; i < annotatedResults.length; i++) {
        const result = annotatedResults[i];
        if (inserted >= articleCap) {
          await markUnprocessedCandidates(
            annotatedResults.slice(i),
            "article_cap_reached",
          );
          break;
        }
        const freshnessReason = freshnessCutoffMs
          ? freshnessOutcomeReason(result, freshnessCutoffMs)
          : null;
        if (freshnessReason) {
          outcomeRecords.push({
            result,
            outcome: {
              accepted: false,
              reason: freshnessReason,
            },
          });
          continue;
        }
        const outcome = await tryInsertDiscoveredArticle(
          result,
          fallbackSourceId,
        );
        outcomeRecords.push({ result, outcome });
        if (outcome.accepted) {
          inserted++;
        }
      }
      await recordDiscoveryCandidateOutcomes(outcomeRecords);

      // Small delay between queries
      await delay(300);
    } catch (error) {
      console.error(`  Error in broad search "${searchQuery}":`, error);
      await logSearchOutcome(
        {
          provider: "tavily",
          segment: "broad",
          searchQuery,
          searchDepth: TAVILY_SEARCH_DEPTH,
        },
        searchStartedAt,
        { status: "error", error },
      );
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
  return discoveryTelemetryScope.run(new DiscoveryTelemetry(), async () => {
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
      discoveryRunId: currentDiscoveryTelemetry().runId,
      providerStats: summarizeProviderStats(),
    };
  });
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
