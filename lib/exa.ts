// lib/exa.ts
// Thin client for Exa's /search endpoint (https://exa.ai/docs/reference/search)
// used by scripts/discover-web.ts as the primary outlet sweep. Plain fetch, no
// SDK: one POST per call, title/url/publishedDate come back without requesting
// `contents` (which is billed per page and unnecessary — we prefetch article
// text ourselves). Exa returns `costDollars.total` per call; callers log it.
//
// Pricing (2026-08): $7 / 1k requests (≤10 results), +$1 / 1k extra results,
// +$1 / 1k pages per content type. Free tier: $10 credits / month.

export type ExaSearchType = "auto" | "fast" | "instant";

export type ExaSearchOptions = {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** ISO 8601; only results published after this instant. */
  startPublishedDate?: string;
  numResults?: number;
  type?: ExaSearchType;
  /** Exa content category; "news" biases toward news index. */
  category?: "news" | null;
};

export type ExaRawResult = {
  id?: string;
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  author?: string | null;
  image?: string | null;
  favicon?: string | null;
};

export type ExaSearchResponse = {
  requestId?: string;
  resolvedSearchType?: string;
  results?: ExaRawResult[];
  costDollars?: { total?: number };
};

export type ExaMappedResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  host: string;
};

export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

/** Request body for /search. Never includes `contents` (cost control). */
export function buildExaSearchBody(
  opts: ExaSearchOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: opts.query,
    type: opts.type ?? "auto",
    numResults: Math.max(1, Math.min(100, opts.numResults ?? 10)),
  };
  if (opts.category) body.category = opts.category;
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
  if (opts.startPublishedDate)
    body.startPublishedDate = opts.startPublishedDate;
  return body;
}

/** Hostname of a URL without a leading "www.", lower-cased; null if unparsable. */
export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** True when `host` is `domain` or a subdomain of it (both www-stripped). */
export function domainMatches(host: string, domain: string): boolean {
  if (!host || !domain) return false;
  const h = host.replace(/^www\./, "").toLowerCase();
  const d = domain.replace(/^www\./, "").toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

// First path segments that denote listings rather than articles.
const LISTING_PREFIXES = new Set([
  "topic",
  "topics",
  "tag",
  "tags",
  "category",
  "categories",
  "section",
  "sections",
  "author",
  "authors",
  "hub",
  "hubs",
  "search",
  "page",
  "newsletters",
  "podcasts",
  "videos",
]);

/**
 * Section/landing pages that search engines happily return but that aren't
 * articles: "/", "/climate", "/topics/climate-change/". Deliberately loose:
 * only the root, a single short digit-free segment, or a listing prefix
 * followed by a short slug count — two-segment paths like /news/wedges or
 * /insights/electrification-explained are real articles on short-slug
 * outlets (drilled.media, WRI) and must reach the downstream date/title/
 * climate gates instead of being dropped here.
 */
export function looksLikeSectionPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const shortSlug = (seg: string) =>
    !/\d/.test(seg) && (seg.match(/-/g) ?? []).length <= 1;
  if (segments.length === 1) return shortSlug(segments[0]);
  if (segments.length === 2) {
    return (
      LISTING_PREFIXES.has(segments[0].toLowerCase()) && shortSlug(segments[1])
    );
  }
  return false;
}

/**
 * Map a raw /search response to article candidates: drops results outside
 * the requested domains, obvious section pages, and untitled rows.
 */
export function mapExaSearchResults(
  response: ExaSearchResponse,
  includeDomains: string[] = [],
): ExaMappedResult[] {
  const out: ExaMappedResult[] = [];
  for (const r of response.results ?? []) {
    if (!r?.url) continue;
    const host = hostFromUrl(r.url);
    if (!host) continue;
    if (
      includeDomains.length > 0 &&
      !includeDomains.some((d) => domainMatches(host, d))
    ) {
      continue;
    }
    let path = "/";
    try {
      path = new URL(r.url).pathname || "/";
    } catch {
      continue;
    }
    if (looksLikeSectionPath(path)) continue;
    const title = (r.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    out.push({
      title,
      url: r.url,
      publishedDate: r.publishedDate ?? undefined,
      author: r.author ?? undefined,
      host,
    });
  }
  return out;
}

export type ExaSearchResult = {
  results: ExaMappedResult[];
  rawCount: number;
  costUsd: number;
  requestId?: string;
  resolvedSearchType?: string;
};

/**
 * Execute one Exa search. Throws on HTTP/network errors so callers can log a
 * provider error row; never throws on an empty result set.
 */
export async function exaSearch(
  opts: ExaSearchOptions,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ExaSearchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(buildExaSearchBody(opts)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Exa HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as ExaSearchResponse;
    return {
      results: mapExaSearchResults(json, opts.includeDomains),
      rawCount: json.results?.length ?? 0,
      costUsd: Number(json.costDollars?.total ?? 0) || 0,
      requestId: json.requestId,
      resolvedSearchType: json.resolvedSearchType,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Month-to-date Exa spend from logged searches (Exa returns costDollars per
 * call, persisted to discovery_searches.cost_usd). One SQL string shared by
 * the discovery budget cap and the health report so they can't disagree.
 */
export const EXA_MONTH_TO_DATE_SPEND_SQL = `SELECT COALESCE(SUM(cost_usd), 0)::float AS usd
     FROM discovery_searches
     WHERE provider = 'exa' AND created_at >= date_trunc('month', now())`;
