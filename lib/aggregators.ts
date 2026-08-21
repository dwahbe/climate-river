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

// Hosts that are real publishers but never worth a lead slot on a climate
// aggregator: press-release wires, stock-tip/PR syndication sites, social
// platforms, and content farms that rewrite other outlets' reporting.
// Articles from these hosts may still join clusters (corroboration) but are
// lead-ineligible (lib/clustering.ts) and skipped at discovery insert.
// Audit 2026-08-21: thecooldown.com alone was 593 articles/14d and led 7 of
// the latest-50 homepage clusters as singletons.
export const LOW_VALUE_HOSTS = [
  // content farms / rewrite sites
  "thecooldown.com",
  "energiesmedia.com",
  "autonocion.com",
  "goodmenproject.com",
  "bgr.com",
  // press-release wires & PR syndication
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "newswise.com",
  "openpr.com",
  "webwire.com",
  "einnews.com",
  "prnasia.com",
  "accesswire.com",
  // stock-tip / market-data sites
  "stocktitan.net",
  "marketbeat.com",
  "simplywall.st",
  "fool.com",
  "indexbox.io",
  "tipranks.com",
  "gurufocus.com",
  "tradingview.com",
  "investing.com",
  "marketscreener.com",
  "seekingalpha.com",
  "benzinga.com",
  "zacks.com",
  // syndication mirrors / social
  "yahoo.com",
  "msn.com",
  "facebook.com",
] as const;

/**
 * Build a case-insensitive POSIX regex for SQL `~*` matches against
 * canonical_url: the host segment must be one of `hosts` or a subdomain of
 * it, so "notfool.com" or "?via=fool.com" never match.
 */
export function hostListSqlRegex(hosts: readonly string[]): string {
  return (
    "^https?://([a-z0-9-]+\\.)*(" +
    hosts.map((h) => h.replace(/\./g, "\\.")).join("|") +
    ")(/|$)"
  );
}

export const LOW_VALUE_URL_SQL_REGEX = hostListSqlRegex(LOW_VALUE_HOSTS);

export function isLowValueHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return LOW_VALUE_HOSTS.some((a) => h === a || h.endsWith("." + a));
}

export function isLowValueUrl(url: string): boolean {
  try {
    return isLowValueHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
