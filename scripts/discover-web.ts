// scripts/discover-web.ts
import { query, endPool } from "@/lib/db";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { categorizeAndStoreArticle } from "@/lib/categorizer";
import { isClimateRelevant } from "@/lib/tagger";
import { isTrustedClimateSource } from "@/config/trustedClimateSources";
import { isLowValueUrl } from "@/lib/aggregators";
import { resolveTier, UNKNOWN_SOURCE_WEIGHT } from "@/config/sourceTiers";
import {
  EXA_MONTH_TO_DATE_SPEND_SQL,
  domainMatches,
  exaSearch,
  hostFromUrl,
  type ExaSearchType,
} from "@/lib/exa";
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
import { resolveGoogleNewsUrl } from "@/lib/googleNews";
import { safeFetch, SsrfError } from "@/lib/urlSafety";
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
  webSearchBudgetExceeded,
  type ArticleDateValidation,
} from "@/lib/utils";

type DiscoveryProvider = "exa" | "openai_web_search" | "google_news_site";

type DiscoverySegment = "outlet";

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
  | "low_value_host"
  | "unresolved_aggregator"
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

// Exa outlet sweep (primary paid tier, 2026-08). Plain REST via lib/exa.ts —
// no contents requested, so a call is $0.007 (+$0.001 per result past 10).
// Throttled to the `full` crons (paidOutletSweep) and capped by a month-to-
// date dollar budget computed from discovery_searches.cost_usd, so the free
// $10/month Exa credit is a hard ceiling, not a hope.
const EXA_API_KEY = process.env.EXA_API_KEY || "";
const EXA_ENABLED = process.env.WEB_SEARCH_EXA === "1" && !!EXA_API_KEY;
const EXA_SEARCH_TYPE: ExaSearchType = (() => {
  const raw = (process.env.EXA_SEARCH_TYPE || "auto").toLowerCase();
  return raw === "fast" || raw === "instant" ? raw : "auto";
})();
const EXA_USE_NEWS_CATEGORY = process.env.EXA_CATEGORY_NEWS !== "0";
const EXA_QUERY =
  process.env.EXA_QUERY ||
  "news about climate change, greenhouse gas emissions, clean energy, extreme weather or climate policy";
// Results per call: high-volume outlets (Reuters/Bloomberg/AP…) publish
// dozens of stories a day and Exa's in-domain ranking is weak for short
// windows, so ask for more and let the relevance gate filter.
const EXA_RESULTS_HIGH_VOLUME = parseEnvInt("EXA_RESULTS_HIGH_VOLUME", 12);
const EXA_RESULTS_LOW_VOLUME = parseEnvInt("EXA_RESULTS_LOW_VOLUME", 10);
const EXA_LOW_VOLUME_BATCH = parseEnvInt("EXA_LOW_VOLUME_BATCH", 5);
// Look-back window per sweep (hours). Live probe 2026-08-21: within 36h
// Exa's index held only ~2 climate items per big outlet (index lag), while a
// 7-day pool ranked ~65% relevant — so 72h (matching outletFreshHours) and
// let the relevance gate + dedup handle repeats.
const EXA_WINDOW_HOURS = parseEnvInt("EXA_WINDOW_HOURS", 72);
const EXA_MONTHLY_BUDGET_USD = parseEnvFloat("EXA_MONTHLY_BUDGET_USD", 10);
// Paid OpenAI web-search fallback. OFF by default: Exa (budget-capped) and the
// free Google News `site:` tier carry outlet discovery. Set WEB_SEARCH_ENABLED=1
// to re-enable the paid serendipity channel (each forced tool call ~$0.01,
// capped by WEB_SEARCH_MAX_CALLS_PER_RUN).
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED === "1";
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
// Hard ceiling on paid OpenAI web-search calls per discovery run (each forces a
// ~$0.01 tool call). A safety net against runaway spend; normal full runs make
// well under this. Set WEB_SEARCH_MAX_CALLS_PER_RUN=0 to disable the cap.
const WEB_SEARCH_MAX_CALLS_PER_RUN = parseEnvInt(
  "WEB_SEARCH_MAX_CALLS_PER_RUN",
  25,
);
const WEB_SEARCH_DEBUG = process.env.WEB_SEARCH_DEBUG === "1";
const WEB_SEARCH_FORCE = process.env.WEB_SEARCH_FORCE === "1";
// Cap on per-run Google News redirect resolutions (~100-150ms network call each)
const WEB_SEARCH_GN_RESOLVE_CAP = parseEnvInt("WEB_SEARCH_GN_RESOLVE_CAP", 40);
const GN_SITE_RESULTS_PER_DOMAIN = 5;
const SEGMENT_SKIP_RECENT_HOURS = 4;

// Wall-clock budget for the current run (set by run() from opts.deadlineAt).
// Segments check hasRunTime() before starting each outlet/batch/query so a
// time-budgeted cron degrades to partial coverage instead of being hard-killed
// at maxDuration (which would also skip the rescore + pipeline_runs logging
// that run after discovery).
let runDeadlineAt = Infinity;
function setRunDeadline(deadlineAt: number): void {
  runDeadlineAt = deadlineAt;
}
function hasRunTime(marginMs = 5_000): boolean {
  return Date.now() < runDeadlineAt - marginMs;
}

// Per-run counters (reset in run()). Single-run CLI/cron, so module state is fine.
const runCounters = { exaSpendUsd: 0 };

/**
 * Exa dollars spent so far this calendar month, from logged discovery_searches
 * rows (cost_usd comes from Exa's per-call costDollars). Used with the in-run
 * counter to enforce EXA_MONTHLY_BUDGET_USD as a hard cap.
 */
async function exaMonthToDateSpendUsd(): Promise<number> {
  try {
    const { rows } = await query<{ usd: number }>(EXA_MONTH_TO_DATE_SPEND_SQL);
    return Number(rows[0]?.usd ?? 0) || 0;
  } catch (error) {
    console.warn(
      "Could not read Exa month-to-date spend (assuming 0):",
      error instanceof Error ? error.message : String(error),
    );
    return 0;
  }
}
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

// Static fallback only — the live answer comes from the sources table (see
// resolveDiscoveryOutlets): an outlet is feed-covered when it has an http feed
// that fetched OK/empty in the last 48h. The old hardcoded list wrongly
// excluded Reuters/AP/WaPo/Bloomberg (no working feed) from every sweep.
const STATIC_RSS_COVERED_DOMAINS = new Set([
  "bbc.com",
  "bbci.co.uk",
  "canarymedia.com",
  "carbon-pulse.com",
  "carbonbrief.org",
  "climate.gov",
  "climatechangenews.com",
  "cleantechnica.com",
  "downtoearth.org.in",
  "energymonitor.ai",
  "ft.com",
  "grist.org",
  "heatmap.news",
  "insideclimatenews.org",
  "jacobin.com",
  "mongabay.com",
  "nature.com",
  "nytimes.com",
  "politico.com",
  "scientificamerican.com",
  "theguardian.com",
  "yaleclimateconnections.org",
]);

// Feed hosts that don't share a registrable root with the outlet domain
// (everything on a plain subdomain — rss.nytimes.com, news.mongabay.com — is
// already handled by the root match in coveredOutletDomains).
const FEED_HOST_ALIASES: Record<string, string> = {
  "bbci.co.uk": "bbc.com",
  "feeds.bbci.co.uk": "bbc.com",
};

// A feed counts as live coverage only if it actually produced an article
// recently — `last_fetch_status` can't tell a dead-but-parsing feed ("Hello
// world!" from 2023) from a quiet one, since ingest writes 'empty' for any
// fetch with zero inserts.
const FEED_COVERAGE_DAYS = 7;

function outletsNotCoveredBy(covered: Set<string>): ClimateOutlet[] {
  return CURATED_CLIMATE_OUTLETS.filter(
    (outlet) => !covered.has(normalizeDomain(outlet.domain)),
  );
}

/**
 * Which outlet domains are covered by the given live feed/homepage hosts.
 * Root-level outlets (nytimes.com) are covered by any feed on a subdomain
 * (rss.nytimes.com); subdomain outlets (earthobservatory.nasa.gov) only by an
 * exact host or an explicit alias — a feed on www.nasa.gov must not cover
 * them. Pure, exported for tests.
 */
export function coveredOutletDomains(
  feedHosts: Iterable<string>,
  outletDomains: string[],
): Set<string> {
  const hosts = new Set<string>();
  for (const raw of feedHosts) {
    const host = normalizeDomain(raw);
    if (!host) continue;
    hosts.add(host);
    const aliased = FEED_HOST_ALIASES[host];
    if (aliased) hosts.add(normalizeDomain(aliased));
  }
  const covered = new Set<string>();
  for (const raw of outletDomains) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    if (hosts.has(d)) {
      covered.add(d);
      continue;
    }
    if (rootDomain(d) === d) {
      for (const h of hosts) {
        if (rootDomain(h) === d) {
          covered.add(d);
          break;
        }
      }
    }
  }
  return covered;
}

/**
 * Outlets that still need a discovery sweep: curated outlets minus those with
 * a live RSS feed in `sources` (one that produced an article in the last
 * FEED_COVERAGE_DAYS). Falls back to the static list if the DB lookup fails.
 */
async function resolveDiscoveryOutlets(): Promise<{
  outlets: ClimateOutlet[];
  source: "db" | "static";
}> {
  try {
    const { rows } = await query<{
      feed_url: string;
      homepage_url: string | null;
    }>(
      `SELECT s.feed_url, s.homepage_url
       FROM sources s
       WHERE s.feed_url LIKE 'http%'
         AND EXISTS (
           SELECT 1 FROM articles a
            WHERE a.source_id = s.id
              AND a.fetched_at > now() - make_interval(days => ${FEED_COVERAGE_DAYS})
         )`,
    );
    const feedHosts: string[] = [];
    for (const row of rows) {
      for (const candidate of [row.feed_url, row.homepage_url]) {
        const host = hostFromUrl(candidate);
        if (host) feedHosts.push(host);
      }
    }
    const coveredOutlets = coveredOutletDomains(
      feedHosts,
      CURATED_CLIMATE_OUTLETS.map((o) => o.domain),
    );
    return { outlets: outletsNotCoveredBy(coveredOutlets), source: "db" };
  } catch (error) {
    console.warn(
      "Falling back to static RSS-covered outlet list:",
      error instanceof Error ? error.message : String(error),
    );
    return {
      outlets: outletsNotCoveredBy(STATIC_RSS_COVERED_DOMAINS),
      source: "static",
    };
  }
}

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
  ["carbon-pulse.com", "ember-energy.org", "energymonitor.ai", "rmi.org"],
  [
    "project-syndicate.org",
    "theatlantic.com",
    "bbc.com",
    "nationalgeographic.com",
  ],
];

const OPENAI_MODEL_PRICING: Record<
  string,
  { inputPerM: number; outputPerM: number }
> = {
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
};

/**
 * Token pricing for cost telemetry, keyed off the actual model (longest-prefix
 * match so dated variants like gpt-4o-mini-2024-07-18 resolve). Unknown models
 * fall back to conservative gpt-4o rates.
 */
export function defaultWebSearchPricing(model: string): {
  inputPerM: number;
  outputPerM: number;
} {
  const match = Object.keys(OPENAI_MODEL_PRICING)
    .filter((key) => model === key || model.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return OPENAI_MODEL_PRICING[match];
  console.warn(
    `⚠️  Unknown web search model "${model}" for cost telemetry; assuming gpt-4o pricing`,
  );
  return OPENAI_MODEL_PRICING["gpt-4o"];
}

const WEB_SEARCH_MODEL_PRICING = defaultWebSearchPricing(WEB_SEARCH_MODEL);
const OPENAI_WEB_SEARCH_INPUT_PER_M = parseEnvFloat(
  "OPENAI_WEB_SEARCH_INPUT_PER_M",
  WEB_SEARCH_MODEL_PRICING.inputPerM,
);
const OPENAI_WEB_SEARCH_OUTPUT_PER_M = parseEnvFloat(
  "OPENAI_WEB_SEARCH_OUTPUT_PER_M",
  WEB_SEARCH_MODEL_PRICING.outputPerM,
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

/**
 * Read-only guard against full+refresh double-runs: true when the segment had
 * a successful search logged within the last SEGMENT_SKIP_RECENT_HOURS.
 */
async function hasRecentSegmentSuccess(
  provider: DiscoveryProvider,
  segment: DiscoverySegment,
): Promise<boolean> {
  if (!(await ensureDiscoveryTelemetryTables())) return false;

  try {
    const { rows } = await query<{ id: number }>(
      `
      SELECT id
      FROM discovery_searches
      WHERE provider = $1
        AND segment = $2
        AND status = 'success'
        AND created_at > NOW() - make_interval(hours => $3)
      LIMIT 1
    `,
      [provider, segment, SEGMENT_SKIP_RECENT_HOURS],
    );
    return rows.length > 0;
  } catch (error) {
    console.error("Failed to check recent discovery segment runs:", error);
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
  const annotated = results.map((result, index): WebSearchResult => ({
    ...result,
    discovery: {
      ...(result.discovery ?? {}),
      provider: params.provider,
      searchId: params.searchId ?? undefined,
      query: params.searchQuery,
      rank: index + 1,
    },
  }));

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

/**
 * OpenAI rejects the web-search `filters` parameter for mini/nano model
 * variants ("Parameter 'filters' not supported with model 'gpt-4.1-mini'" —
 * 1,053/1,053 production calls failed this way). Domain enforcement still
 * happens client-side via isAllowedDomain.
 */
export function modelSupportsWebSearchFilters(model: string): boolean {
  return !/-(mini|nano)(-|$)/.test(model);
}

async function callOpenAIWebSearch(
  query: string,
  overrides?: WebSearchOverrides,
): Promise<{ results: WebSearchResult[]; stats: WebBrowseStats | null }> {
  if (!WEB_SEARCH_ENABLED) {
    return { results: [], stats: null };
  }

  // Per-run cost ceiling: skip once this run has already made the configured
  // number of paid OpenAI web-search calls.
  const callsSoFar = getProviderStats("openai_web_search").searches;
  if (webSearchBudgetExceeded(callsSoFar, WEB_SEARCH_MAX_CALLS_PER_RUN)) {
    console.warn(
      `⚠️  Skipping OpenAI web search — per-run cap reached (${callsSoFar}/${WEB_SEARCH_MAX_CALLS_PER_RUN}): "${query}"`,
    );
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
      instructions: systemMessage,
      prompt: userMessage,
      tools: {
        webSearch: openai.tools.webSearch({
          searchContextSize: WEB_SEARCH_CONTEXT_SIZE,
          ...(allowedDomains &&
          allowedDomains.length > 0 &&
          modelSupportsWebSearchFilters(WEB_SEARCH_MODEL)
            ? { filters: { allowedDomains } }
            : {}),
        }),
      },
      toolChoice: WEB_SEARCH_FORCE_TOOL
        ? { type: "tool", toolName: "webSearch" }
        : "auto",
      // maxOutputTokens enforces the cap. (The previous
      // providerOptions.openai.maxCompletionTokens was dead config — it is not
      // part of the Responses API tool path and was silently dropped.)
      maxOutputTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
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

export function buildGoogleNewsSiteQuery(domain: string): string {
  return `site:${normalizeDomain(domain)} when:2d`;
}

export function buildGoogleNewsSiteFeedUrl(domain: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(buildGoogleNewsSiteQuery(domain))}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Free outlet discovery via Google News site: RSS queries (replaces paid
 * paid sweeps). Links resolve to publisher URLs through
 * resolveGoogleNewsUrl, capped per run; candidates left on news.google.com
 * are returned separately so callers reject them instead of inserting
 * aggregator URLs.
 */
async function searchGoogleNewsSiteOutlet(
  domain: string,
  resolveState: { used: number },
): Promise<{ results: WebSearchResult[]; unresolved: WebSearchResult[] }> {
  const searchQuery = buildGoogleNewsSiteQuery(domain);
  const startedAt = Date.now();

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
    console.log(`📰 Google News site search: ${searchQuery}`);
    const feed = await parser.parseURL(buildGoogleNewsSiteFeedUrl(domain));
    const items = (feed.items || []).slice(0, GN_SITE_RESULTS_PER_DOMAIN);

    const collected: WebSearchResult[] = [];
    for (const item of items) {
      if (!item.title || !item.link) continue;

      let realUrl = extractRealUrl(item.link);
      if (
        hostFromUrl(realUrl) === "news.google.com" &&
        resolveState.used < WEB_SEARCH_GN_RESOLVE_CAP
      ) {
        resolveState.used++;
        const resolution = await resolveGoogleNewsUrl(item.link);
        if (resolution.url) {
          realUrl = canonical(resolution.url);
        }
      }

      const publisher = extractPublisherFromRssItem(item);
      collected.push({
        title: cleanGoogleNewsTitle(item.title),
        url: realUrl,
        snippet: item.contentSnippet || item.content || "",
        publishedDate: item.isoDate || item.pubDate,
        source: publisher.name || extractSourceFromUrl(realUrl),
        publisherHomepage: publisher.homepage,
      });
    }

    const meta: SearchTelemetryMeta = {
      provider: "google_news_site",
      segment: "outlet",
      searchQuery,
      requestedDomains: [domain],
    };
    const searchId = await logSearchOutcome(meta, startedAt, {
      status: "success",
      resultCount: collected.length,
    });
    const annotated = await attachDiscoveryCandidates(collected, {
      provider: "google_news_site",
      searchId,
      searchQuery,
    });

    return {
      results: annotated.filter(
        (result) => hostFromUrl(result.url) !== "news.google.com",
      ),
      unresolved: annotated.filter(
        (result) => hostFromUrl(result.url) === "news.google.com",
      ),
    };
  } catch (error) {
    console.error(`Google News site search error for ${domain}:`, error);
    await logSearchOutcome(
      {
        provider: "google_news_site",
        segment: "outlet",
        searchQuery,
        requestedDomains: [domain],
      },
      startedAt,
      { status: "error", error },
    );
    return { results: [], unresolved: [] };
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

  // Tiered hosts get their configured weight; everything else gets the same
  // unknown-source default as RSS/GN discovery (2). The old flat 4 put
  // "Trend Hunter"/"Raspberry Pi" above unknown-but-real newsrooms and let
  // them lead clusters. Scale is 1–10; see config/sourceTiers.ts.
  const DEFAULT_WEB_DISCOVERED_WEIGHT =
    resolveTier(host) ?? UNKNOWN_SOURCE_WEIGHT;

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
    const response = await safeFetch(url, {
      method: "HEAD",
      signal: controller.signal,
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
  } catch (error) {
    // Reject URLs that point at private/internal address space outright.
    if (error instanceof SsrfError) {
      console.warn(`🚫 Blocked unsafe discovery URL ${url}: ${error.message}`);
      return false;
    }
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

function emptySegmentStats(): DiscoverySegmentStats {
  return {
    inserted: 0,
    scanned: 0,
    queriesRun: 0,
    browseCost: 0,
    browseToolCalls: 0,
    duration: 0,
  };
}

// Rejection reasons that still prove a domain is being covered (the article
// is already in the river).
const DUPLICATE_REASONS = new Set<DiscoveryOutcomeReason>([
  "duplicate_url",
  "duplicate_title",
  "duplicate_candidate",
]);

/**
 * Shared tail of every discovery segment: walk deduped candidates in order,
 * stop at the article cap (marking the rest), skip stale items, insert the
 * rest, and record every outcome. Returns the inserted count and outcomes so
 * callers can derive coverage from what was actually accepted.
 */
async function insertCollectedCandidates(params: {
  results: WebSearchResult[];
  articleCap: number;
  insertedSoFar?: number;
  freshnessCutoffMs: number | null;
  fallbackSourceId: number;
}): Promise<{ inserted: number; outcomes: CandidateOutcomeRecord[] }> {
  const { results, articleCap, freshnessCutoffMs, fallbackSourceId } = params;
  let inserted = params.insertedSoFar ?? 0;
  let newlyInserted = 0;
  const outcomes: CandidateOutcomeRecord[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (inserted >= articleCap) {
      await markUnprocessedCandidates(results.slice(i), "article_cap_reached");
      break;
    }
    const freshnessReason = freshnessCutoffMs
      ? freshnessOutcomeReason(result, freshnessCutoffMs)
      : null;
    if (freshnessReason) {
      console.log(
        `- Skipped stale (${result.publishedDate ?? "unknown"}): ${result.title.substring(0, 80)}`,
      );
      outcomes.push({
        result,
        outcome: { accepted: false, reason: freshnessReason },
      });
      continue;
    }
    const outcome = await tryInsertDiscoveredArticle(result, fallbackSourceId);
    outcomes.push({ result, outcome });
    if (outcome.accepted) {
      inserted++;
      newlyInserted++;
    }
  }
  await recordDiscoveryCandidateOutcomes(outcomes);
  return { inserted: newlyInserted, outcomes };
}

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

  // Match ingest pipeline normalization (before the gate so the trusted-host
  // check sees the publisher URL, not a redirect wrapper)
  result = { ...result, url: canonical(extractRealUrl(result.url)) };

  // Climate-only outlets (config/trustedClimateSources.ts) bypass the keyword
  // gate — it dropped ~20% of Grist / 17% of Heatmap items in the 2026-08 audit.
  const trusted = isTrustedClimateSource({ url: result.url });
  const isClimate =
    trusted ||
    isClimateRelevant({
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

  // PR wires / stock-tip sites / content farms (lib/aggregators.ts)
  if (isLowValueUrl(result.url)) {
    console.log(
      `- Skipped low-value host ${normalizedHost}: ${result.title.substring(0, 80)}`,
    );
    return { accepted: false, reason: "low_value_host" };
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

  // Cheap DB duplicate check BEFORE the network reachability probe — most
  // sweep results on later runs are already-known URLs.
  const duplicate = await findDuplicate(result.title, result.url);

  if (duplicate.duplicate) {
    console.log(`- Skipped duplicate: ${result.title.substring(0, 60)}...`);
    return {
      accepted: false,
      reason: duplicate.reason,
      duplicateArticleId: duplicate.articleId,
    };
  }

  const reachable = await isUrlReachable(result.url);
  if (!reachable) {
    console.log(
      `⚠️  Skipping unreachable URL (404/410): ${result.url} ("${result.title.substring(0, 60)}...")`,
    );
    return { accepted: false, reason: "unreachable" };
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
      { trusted },
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

function buildOutletBatches(
  outlets: ClimateOutlet[],
  batchSize: number,
): ClimateOutlet[][] {
  const byDomain = new Map(outlets.map((outlet) => [outlet.domain, outlet]));
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

  const leftovers = outlets.filter((outlet) => !assigned.has(outlet.domain));

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
  coveredDomains,
  outlets,
}: {
  fallbackSourceId: number;
  limitPerBatch: number;
  batchSize: number;
  articleCap: number;
  freshHours: number;
  coveredDomains?: Set<string>;
  outlets: ClimateOutlet[];
}): Promise<DiscoverySegmentStats> {
  if (outlets.length === 0 || articleCap <= 0) return emptySegmentStats();

  // This segment is the paid OpenAI web-search gap-filler (opt-in).
  if (!WEB_SEARCH_ENABLED) {
    console.log(
      "OpenAI outlet fallback disabled (set WEB_SEARCH_ENABLED=1 to enable)",
    );
    return emptySegmentStats();
  }

  const segmentStart = Date.now();
  const outletBatches = buildOutletBatches(outlets, batchSize);
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
    if (!hasRunTime()) {
      console.log("⏱️  Deadline reached — skipping remaining outlet batches");
      break;
    }

    const outletNames = batch.map((outlet) => outlet.promptHint || outlet.name);
    const normalizedDomainEntries = batch.map((outlet) => ({
      outlet,
      raw: outlet.domain,
      normalized: normalizeDomain(outlet.domain),
    }));

    console.log(`Searching (site-specific batch): ${outletNames.join(", ")}`);

    let batchResults: WebSearchResult[] = [];

    // Check which domains already have coverage (Exa / Google News site:
    // tiers), so the paid OpenAI fallback only runs for gaps.
    const domainHitCounts = new Map<string, number>();
    for (const entry of normalizedDomainEntries) {
      if (coveredDomains?.has(entry.normalized)) {
        domainHitCounts.set(entry.normalized, 1);
      }
    }
    updateDomainHitCounts(
      domainHitCounts,
      batchResults,
      normalizedDomainEntries.map((entry) => entry.normalized),
    );

    const missingDomainEntries = normalizedDomainEntries.filter(
      (entry) => (domainHitCounts.get(entry.normalized) ?? 0) === 0,
    );

    // OpenAI web search for domains still missing coverage
    if (missingDomainEntries.length > 0) {
      console.log(
        `  → OpenAI web search for ${missingDomainEntries.length} uncovered domains: ${missingDomainEntries
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
    }

    // Check for domains still missing coverage after the OpenAI fallback
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

    const batchInsert = await insertCollectedCandidates({
      results: batchResults,
      articleCap,
      insertedSoFar: inserted,
      freshnessCutoffMs,
      fallbackSourceId,
    });
    inserted += batchInsert.inserted;

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

/**
 * One Exa /search call over a domain group. Returns in-domain article
 * candidates (title/url/publishedDate, no contents) with telemetry attached.
 */
async function searchViaExa(
  domains: string[],
  opts: { numResults: number; freshHours: number },
): Promise<{ results: WebSearchResult[]; cost: number }> {
  const segment: DiscoverySegment = "outlet";
  const startPublishedDate = new Date(
    Date.now() - opts.freshHours * 60 * 60 * 1000,
  ).toISOString();
  const searchQuery = EXA_QUERY;
  const startedAt = Date.now();
  const meta: SearchTelemetryMeta = {
    provider: "exa",
    segment,
    searchQuery,
    requestedDomains: domains,
    searchDepth: EXA_SEARCH_TYPE,
  };
  try {
    console.log(
      `🔎 Exa search (${EXA_SEARCH_TYPE}${EXA_USE_NEWS_CATEGORY ? ", news" : ""}, ${opts.numResults} results, ${opts.freshHours}h): ${domains.join(", ")}`,
    );
    const response = await exaSearch(
      {
        query: searchQuery,
        includeDomains: domains,
        startPublishedDate,
        numResults: opts.numResults,
        type: EXA_SEARCH_TYPE,
        category: EXA_USE_NEWS_CATEGORY ? "news" : null,
      },
      EXA_API_KEY,
    );
    runCounters.exaSpendUsd += response.costUsd;
    const results: WebSearchResult[] = response.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: "",
      publishedDate: r.publishedDate,
      source: humanizeHost(r.host),
      discovery: { raw: { exaRequestId: response.requestId } },
    }));
    console.log(
      `  Exa returned ${results.length}/${response.rawCount} in-domain results ($${response.costUsd.toFixed(4)})`,
    );
    const searchId = await logSearchOutcome(meta, startedAt, {
      status: "success",
      resultCount: results.length,
      costUsd: response.costUsd,
    });
    return {
      results: await attachDiscoveryCandidates(results, {
        provider: "exa",
        searchId,
        searchQuery,
      }),
      cost: response.costUsd,
    };
  } catch (error) {
    console.error(`Exa search error for ${domains.join(", ")}:`, error);
    await logSearchOutcome(meta, startedAt, { status: "error", error });
    return { results: [], cost: 0 };
  }
}

/**
 * Primary paid outlet sweep (2026-08): Exa over the curated outlets that have
 * no live feed. High-volume outlets get one call each; the rest are batched
 * EXA_LOW_VOLUME_BATCH domains per call. Month-to-date spend + in-run spend
 * must stay under EXA_MONTHLY_BUDGET_USD. Returns the domains that produced
 * at least one candidate so the free GN `site:` tier only runs for the gaps.
 */
async function runExaOutletSegment({
  fallbackSourceId,
  articleCap,
  freshHours,
  outlets,
}: {
  fallbackSourceId: number;
  articleCap: number;
  freshHours: number;
  outlets: ClimateOutlet[];
}): Promise<DiscoverySegmentStats & { coveredDomains: Set<string> }> {
  const emptyStats = {
    ...emptySegmentStats(),
    coveredDomains: new Set<string>(),
  };
  if (!EXA_ENABLED) {
    console.log(
      "Exa outlet sweep disabled (set WEB_SEARCH_EXA=1 and EXA_API_KEY to enable)",
    );
    return emptyStats;
  }
  if (outlets.length === 0 || articleCap <= 0) return emptyStats;
  if (!WEB_SEARCH_FORCE && (await hasRecentSegmentSuccess("exa", "outlet"))) {
    console.log(
      `Skipping Exa outlet sweep — successful run within the last ${SEGMENT_SKIP_RECENT_HOURS}h (set WEB_SEARCH_FORCE=1 to override)`,
    );
    return emptyStats;
  }

  const segmentStart = Date.now();
  const monthSpend = await exaMonthToDateSpendUsd();
  const budgetLeft = EXA_MONTHLY_BUDGET_USD - monthSpend;
  console.log(
    `\n🔎 Exa outlet sweep (${outlets.length} outlets; month-to-date $${monthSpend.toFixed(3)} of $${EXA_MONTHLY_BUDGET_USD.toFixed(2)} budget)`,
  );
  if (EXA_MONTHLY_BUDGET_USD > 0 && budgetLeft <= 0) {
    console.warn("⚠️  Exa monthly budget exhausted — skipping sweep");
    return emptyStats;
  }

  // freshHours <= 0 means "no freshness cutoff" elsewhere in this file; for
  // the Exa look-back that means the default window, not a 6h floor.
  const windowHours =
    freshHours > 0
      ? Math.max(6, Math.min(freshHours, EXA_WINDOW_HOURS))
      : EXA_WINDOW_HOURS;
  const freshnessCutoffMs =
    freshHours > 0 ? Date.now() - freshHours * 60 * 60 * 1000 : null;
  const high = outlets.filter((o) => o.volume === "high");
  const low = outlets.filter((o) => o.volume !== "high");
  const groups: { domains: string[]; numResults: number }[] = [
    ...high.map((o) => ({
      domains: [o.domain],
      numResults: EXA_RESULTS_HIGH_VOLUME,
    })),
    ...chunkArray(low, EXA_LOW_VOLUME_BATCH).map((batch) => ({
      domains: batch.map((o) => o.domain),
      numResults: EXA_RESULTS_LOW_VOLUME,
    })),
  ];

  let collected: WebSearchResult[] = [];
  let queriesRun = 0;
  let browseCost = 0;

  // Calls are independent and cheap; run a few concurrently (well under
  // Exa's 10 QPS) and re-check the deadline/budget between batches.
  const EXA_CONCURRENCY = 3;
  for (let i = 0; i < groups.length; i += EXA_CONCURRENCY) {
    if (!hasRunTime()) {
      console.log("⏱️  Deadline reached — skipping remaining Exa groups");
      break;
    }
    if (
      EXA_MONTHLY_BUDGET_USD > 0 &&
      monthSpend + runCounters.exaSpendUsd >= EXA_MONTHLY_BUDGET_USD
    ) {
      console.warn("⚠️  Exa monthly budget reached mid-sweep — stopping");
      break;
    }
    const batch = groups.slice(i, i + EXA_CONCURRENCY);
    const settled = await Promise.all(
      batch.map((group) =>
        searchViaExa(group.domains, {
          numResults: group.numResults,
          freshHours: windowHours,
        }),
      ),
    );
    for (const { results, cost } of settled) {
      queriesRun++;
      browseCost += cost;
      collected.push(...results);
    }
  }

  collected = await dedupeWebResultsForProcessing(collected);
  const scanned = collected.length;

  const { inserted, outcomes } = await insertCollectedCandidates({
    results: collected,
    articleCap,
    freshnessCutoffMs,
    fallbackSourceId,
  });

  // A domain is covered only when Exa produced something the river keeps
  // (accepted, or already present as a duplicate) — not when every result
  // was stale/non-climate/low-value — so the free GN tier still runs for gaps.
  const coveredDomains = new Set<string>();
  const outletDomains = outlets.map((o) => normalizeDomain(o.domain));
  for (const { result, outcome } of outcomes) {
    if (!outcome.accepted && !DUPLICATE_REASONS.has(outcome.reason)) continue;
    const host = hostFromUrl(result.url);
    if (!host) continue;
    for (const domain of outletDomains) {
      if (domainMatches(normalizeDomain(host), domain))
        coveredDomains.add(domain);
    }
  }

  console.log(
    `  Exa sweep complete: ${inserted} articles from ${scanned} results, ${queriesRun} calls, $${browseCost.toFixed(4)}`,
  );
  return {
    inserted,
    scanned,
    queriesRun,
    browseCost,
    browseToolCalls: 0,
    duration: Math.round((Date.now() - segmentStart) / 1000),
    coveredDomains,
  };
}

async function runGoogleNewsSiteOutletSegment({
  fallbackSourceId,
  articleCap,
  freshHours,
  outlets,
}: {
  fallbackSourceId: number;
  articleCap: number;
  freshHours: number;
  outlets: ClimateOutlet[];
}): Promise<DiscoverySegmentStats & { coveredDomains: Set<string> }> {
  const emptyStats = {
    ...emptySegmentStats(),
    coveredDomains: new Set<string>(),
  };

  if (outlets.length === 0 || articleCap <= 0) {
    return emptyStats;
  }

  if (
    !WEB_SEARCH_FORCE &&
    (await hasRecentSegmentSuccess("google_news_site", "outlet"))
  ) {
    console.log(
      `Skipping Google News site: discovery — successful run within the last ${SEGMENT_SKIP_RECENT_HOURS}h (set WEB_SEARCH_FORCE=1 to override)`,
    );
    return emptyStats;
  }

  const segmentStart = Date.now();
  const freshnessCutoffMs =
    freshHours > 0 ? Date.now() - freshHours * 60 * 60 * 1000 : null;
  const resolveState = { used: 0 };
  const coveredDomains = new Set<string>();

  console.log(
    `\n📰 Google News site: discovery (${outlets.length} domains, resolve cap ${WEB_SEARCH_GN_RESOLVE_CAP})`,
  );

  let collected: WebSearchResult[] = [];
  let queriesRun = 0;

  for (const outlet of outlets) {
    if (!hasRunTime()) {
      console.log(
        `⏱️  Deadline reached — skipping remaining GN site: outlets (${queriesRun}/${outlets.length} queried)`,
      );
      break;
    }
    const { results, unresolved } = await searchGoogleNewsSiteOutlet(
      outlet.domain,
      resolveState,
    );
    queriesRun++;

    if (unresolved.length > 0) {
      console.log(
        `  ${outlet.domain}: rejected ${unresolved.length} unresolved aggregator links`,
      );
      await markUnprocessedCandidates(unresolved, "unresolved_aggregator");
    }

    const inDomain = results.filter((result) =>
      isAllowedDomain(result.url, [outlet.domain]),
    );
    const outOfDomain = results.filter(
      (result) => !isAllowedDomain(result.url, [outlet.domain]),
    );
    if (outOfDomain.length > 0) {
      await markUnprocessedCandidates(outOfDomain, "out_of_domain");
    }

    if (inDomain.length > 0) {
      coveredDomains.add(normalizeDomain(outlet.domain));
    }
    collected.push(...inDomain);

    await delay(DISCOVERY_PAUSE_MS);
  }

  collected = await dedupeWebResultsForProcessing(collected);
  const scanned = collected.length;

  const { inserted } = await insertCollectedCandidates({
    results: collected,
    articleCap,
    freshnessCutoffMs,
    fallbackSourceId,
  });

  console.log(
    `  Google News site: discovery complete: ${inserted} articles from ${scanned} results (${resolveState.used} URL resolutions)`,
  );

  return {
    inserted,
    scanned,
    queriesRun,
    browseCost: 0,
    browseToolCalls: 0,
    duration: Math.round((Date.now() - segmentStart) / 1000),
    coveredDomains,
  };
}

export async function run(
  opts: {
    closePool?: boolean;
    outletArticleCap?: number;
    outletLimitPerBatch?: number;
    outletBatchSize?: number;
    outletFreshHours?: number;
    // Absolute wall-clock deadline (Date.now() ms). Segments stop starting new
    // outlets/batches/queries once it passes, so a time-budgeted cron can call
    // this without risking a hard kill at maxDuration.
    deadlineAt?: number;
    // Paid outlet sweeps (Exa, OpenAI) run only when true — the full
    // cron (3×/day) passes true, refresh passes false, so spend is bounded to
    // ~24 Exa calls/day regardless of cron cadence. Free GN site: still runs.
    paidOutletSweep?: boolean;
  } = {},
) {
  return discoveryTelemetryScope.run(new DiscoveryTelemetry(), async () => {
    const startTime = Date.now();
    runCounters.exaSpendUsd = 0;
    const paidOutletSweep = opts.paidOutletSweep !== false;
    const outletArticleCap = opts.outletArticleCap ?? 70;
    const outletLimitPerBatch = Math.max(4, opts.outletLimitPerBatch ?? 12);
    const outletBatchSize = Math.max(2, opts.outletBatchSize ?? 4);
    const outletFreshHours =
      opts.outletFreshHours ?? DEFAULT_OUTLET_FRESHNESS_HOURS;
    setRunDeadline(opts.deadlineAt ?? Infinity);

    console.log("Starting web discovery...");
    console.log(
      `Search tiers: ${EXA_ENABLED && paidOutletSweep ? "1) Exa outlets → " : ""}${paidOutletSweep ? "" : "[paid sweeps off] "}2) Google News site:${WEB_SEARCH_ENABLED && paidOutletSweep ? " → 3) OpenAI" : ""}`,
    );

    // Outlets that still need a sweep = curated minus those with a live feed.
    const resolved = await resolveDiscoveryOutlets();
    const outlets = resolved.outlets;
    console.log(
      `Sweep universe (${resolved.source}): ${outlets.length} outlets without a live feed` +
        (outlets.length > 0
          ? ` — ${outlets.map((o) => o.domain).join(", ")}`
          : ""),
    );

    const fallbackSourceId = await getOrCreateWebDiscoverySource();

    // Tier 1: Exa sweep over feedless outlets (paid, budget-capped)
    const exaStats = paidOutletSweep
      ? await runExaOutletSegment({
          fallbackSourceId,
          articleCap: outletArticleCap,
          freshHours: outletFreshHours,
          outlets,
        })
      : { ...emptySegmentStats(), coveredDomains: new Set<string>() };

    // Tier 2: Free Google News site: queries for outlets Exa didn't cover
    // (free, so it keeps its own article cap rather than sharing Exa's)
    const gnOutlets = outlets.filter(
      (o) => !exaStats.coveredDomains.has(normalizeDomain(o.domain)),
    );
    const gnSiteStats = await runGoogleNewsSiteOutletSegment({
      fallbackSourceId,
      articleCap: outletArticleCap,
      freshHours: outletFreshHours,
      outlets: gnOutlets,
    });

    // Tier 3: OpenAI web search (opt-in) for domains still missing coverage
    const coveredSoFar = new Set<string>([
      ...exaStats.coveredDomains,
      ...gnSiteStats.coveredDomains,
    ]);
    const outletStats = paidOutletSweep
      ? await runOutletDiscoverySegment({
          fallbackSourceId,
          limitPerBatch: outletLimitPerBatch,
          batchSize: outletBatchSize,
          articleCap: Math.max(
            0,
            outletArticleCap - exaStats.inserted - gnSiteStats.inserted,
          ),
          freshHours: outletFreshHours,
          coveredDomains: coveredSoFar,
          outlets,
        })
      : emptySegmentStats();

    if (outletStats.queriesRun > 0) {
      console.log(
        `OpenAI outlet fallback complete: ${outletStats.inserted} new articles from ${outletStats.scanned} results`,
      );
    } else {
      const why = !paidOutletSweep
        ? "paid sweeps off for this run"
        : !WEB_SEARCH_ENABLED
          ? "WEB_SEARCH_ENABLED is off"
          : outlets.length === 0
            ? "no outlets need a sweep"
            : "every outlet already covered or article cap reached";
      console.log(`OpenAI outlet fallback skipped (${why})`);
    }

    const totalInserted =
      exaStats.inserted + gnSiteStats.inserted + outletStats.inserted;
    const totalScanned =
      exaStats.scanned + gnSiteStats.scanned + outletStats.scanned;
    const totalBrowseCost = exaStats.browseCost + outletStats.browseCost;
    const totalBrowseToolCalls = outletStats.browseToolCalls;
    const totalQueries =
      exaStats.queriesRun + gnSiteStats.queriesRun + outletStats.queriesRun;

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `Web discovery completed: ${totalInserted} new articles from ${totalScanned} results in ${duration}s`,
    );

    if (totalBrowseCost > 0) {
      console.log(
        `Estimated search spend: ~$${totalBrowseCost.toFixed(4)} ` +
          `(${EXA_ENABLED ? "Exa + " : ""}OpenAI${totalBrowseToolCalls > 0 ? `, ${totalBrowseToolCalls} tool calls` : ""})`,
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
