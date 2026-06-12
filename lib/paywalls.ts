// lib/paywalls.ts
// Single source of truth for hard-paywall publisher domains where reader
// extraction reliably fails. Kept dependency-free so SQL-building scripts
// and client components can both import it (mirrors lib/aggregators.ts).

export const PAYWALL_DOMAINS = [
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "economist.com",
  "bloomberg.com",
  "washingtonpost.com",
  "newyorker.com",
  "theathletic.com",
  "foreignpolicy.com",
] as const;

export function isPaywallHost(host: string): boolean {
  const h = host.toLowerCase();
  // Exact or subdomain match — a substring check would catch e.g.
  // microsoft.com via "ft.com"
  return PAYWALL_DOMAINS.some((d) => h === d || h.endsWith("." + d));
}

export function isPaywallUrl(url: string): boolean {
  try {
    return isPaywallHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Case-insensitive POSIX regex fragment for SQL `~*` matches against
// canonical_url, anchored to the host portion so path/query substrings
// (or hosts like microsoft.com vs ft.com) can't false-positive.
export const PAYWALL_URL_SQL_REGEX =
  "://([^/]*\\.)?(" +
  PAYWALL_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|") +
  ")(/|$)";
