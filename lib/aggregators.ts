// lib/aggregators.ts
// Single source of truth for news-aggregator hosts (interstitial pages, not
// publishers). Kept dependency-free so SQL-building modules and the health
// report can import it without pulling in AI/SDK dependencies.

export const AGGREGATOR_HOSTS = [
  "news.google.com",
  "news.yahoo.com",
  "www.msn.com",
] as const;

// Case-insensitive POSIX regex fragment for SQL `~*` matches against
// canonical_url. Matches the host anywhere in the URL string.
export const AGGREGATOR_URL_SQL_REGEX =
  "news\\.google\\.|news\\.yahoo\\.com|www\\.msn\\.com";

export function isAggregatorHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return AGGREGATOR_HOSTS.some((a) => {
    const bare = a.replace(/^www\./, "");
    return h === bare || h.endsWith("." + bare);
  });
}

export function isAggregatorUrl(url: string): boolean {
  try {
    return isAggregatorHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
