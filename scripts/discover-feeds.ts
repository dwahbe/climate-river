// scripts/discover-feeds.ts
// Feed autodiscovery: graduate pseudo-feed sources (discover://<host>, created
// when discovery finds articles on hosts we have no RSS feed for) into real
// RSS sources. For hosts that produced ≥3 articles in the last 30 days, probe
// <link rel="alternate"> on the homepage plus well-known feed paths, validate
// that the feed parses and is fresh, and point the source row at it. Real
// feeds beat discovery: full metadata, no URL resolution, no per-article cost.
//
//   bun run feeds:discover          # dry-run, top 15 hosts
//   bun run feeds:discover:apply    # apply
//   bun scripts/discover-feeds.ts --apply --limit 30

import { query, endPool } from "@/lib/db";
import { safeFetch } from "@/lib/urlSafety";

const FETCH_TIMEOUT_MS = 8_000;
const FEED_MAX_AGE_DAYS = 30;
const MAX_CANDIDATES_PER_HOST = 6;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; ClimateRiverBot/0.1; +https://climateriver.org)",
  Accept:
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.7",
};

// Well-known feed locations, probed after any <link rel="alternate"> hits.
export const WELL_KNOWN_FEED_PATHS = [
  "/feed",
  "/rss",
  "/atom.xml",
  "/feed.xml",
  "/rss.xml",
  "/index.xml",
] as const;

/**
 * Pull RSS/Atom <link rel="alternate"> URLs out of homepage HTML, resolved
 * against the page URL. Regex-based on purpose — no DOM dependency, and feed
 * link tags are a flat, well-behaved pattern.
 */
export function extractFeedLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkTagRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkTagRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel=["']?alternate["']?/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml["']?/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {
      // unresolvable href — skip
    }
  }
  return links;
}

/**
 * Candidate feed URLs for a host: homepage-declared feeds first (most
 * authoritative), then well-known paths. Deduped, http(s)-only, capped.
 */
export function feedCandidateUrls(
  homepage: string,
  discovered: string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string) => {
    let normalized: string;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      normalized = parsed.toString();
    } catch {
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const u of discovered) push(u);
  for (const path of WELL_KNOWN_FEED_PATHS) {
    try {
      push(new URL(path, homepage).toString());
    } catch {
      // bad homepage URL — caller validates
    }
  }
  return out.slice(0, MAX_CANDIDATES_PER_HOST);
}

/** A feed is worth ingesting only if it still publishes: newest item within maxAgeDays. */
export function isFreshFeed(
  items: Array<{ isoDate?: string; pubDate?: string }>,
  maxAgeDays: number,
): boolean {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  return items.some((item) => {
    const raw = item.isoDate || item.pubDate;
    if (!raw) return false;
    const t = Date.parse(raw);
    return Number.isFinite(t) && t >= cutoff && t <= Date.now() + 86_400_000;
  });
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Probe one host: returns the first valid (parses + fresh) feed URL, or null. */
async function findValidFeed(homepage: string): Promise<string | null> {
  const Parser = (await import("rss-parser")).default;
  const parser = new Parser();

  const homepageHtml = await fetchText(homepage);
  const declared = homepageHtml ? extractFeedLinks(homepageHtml, homepage) : [];
  const candidates = feedCandidateUrls(homepage, declared);

  for (const candidate of candidates) {
    const body = await fetchText(candidate);
    if (!body) continue;
    try {
      const feed = await parser.parseString(body);
      const items = feed.items ?? [];
      if (items.length > 0 && isFreshFeed(items, FEED_MAX_AGE_DAYS)) {
        return candidate;
      }
    } catch {
      // not a feed — next candidate
    }
  }
  return null;
}

export async function run(
  opts: { limit?: number; apply?: boolean; closePool?: boolean } = {},
) {
  const limit = opts.limit ?? 15;
  const apply = opts.apply ?? false;

  console.log(
    `📡 Feed autodiscovery — ${apply ? "APPLY" : "DRY RUN"}, top ${limit} pseudo-feed hosts`,
  );

  // Hosts worth a real feed: pseudo-feed sources that discovery keeps finding
  // articles for. Excluded automatically once upgraded (feed_url becomes http).
  const { rows: candidates } = await query<{
    id: number;
    name: string;
    homepage_url: string | null;
    feed_url: string;
    articles_30d: number;
  }>(
    `
    SELECT s.id, s.name, s.homepage_url, s.feed_url, COUNT(a.id)::int AS articles_30d
    FROM sources s
    JOIN articles a
      ON a.source_id = s.id
     AND a.fetched_at >= now() - interval '30 days'
    WHERE s.feed_url LIKE 'discover://%'
    GROUP BY s.id
    HAVING COUNT(a.id) >= 3
    ORDER BY COUNT(a.id) DESC
    LIMIT $1
  `,
    [limit],
  );
  console.log(
    `  ${candidates.length} hosts with ≥3 discovered articles in 30d`,
  );

  let upgraded = 0;
  let noFeed = 0;
  let duplicate = 0;

  for (const source of candidates) {
    const host = source.feed_url.replace(/^discover:\/\//, "");
    const homepage = source.homepage_url || `https://${host}`;

    const feedUrl = await findValidFeed(homepage);
    if (!feedUrl) {
      noFeed++;
      console.log(
        `  ✗ ${host}: no valid feed found (${source.articles_30d} articles/30d)`,
      );
      continue;
    }

    // Another source row may already own this feed (e.g. a curated entry).
    const { rows: owner } = await query<{ id: number }>(
      `SELECT id FROM sources WHERE feed_url = $1 AND id <> $2 LIMIT 1`,
      [feedUrl, source.id],
    );
    if (owner.length > 0) {
      duplicate++;
      console.log(
        `  ⏭️  ${host}: feed ${feedUrl} already owned by source ${owner[0].id}`,
      );
      continue;
    }

    console.log(
      `  ✓ ${host} → ${feedUrl} (${source.articles_30d} articles/30d)`,
    );
    if (apply) {
      await query(`UPDATE sources SET feed_url = $1 WHERE id = $2`, [
        feedUrl,
        source.id,
      ]);
    }
    upgraded++;
  }

  const summary = {
    scanned: candidates.length,
    upgraded,
    noFeed,
    duplicate,
    apply,
  };
  console.log(`\n📊 Feed autodiscovery summary:`, summary);
  if (opts.closePool) await endPool();
  return summary;
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const limitFlag = argv.find((a) => a.startsWith("--limit="));
  run({
    apply: argv.includes("--apply"),
    limit: limitFlag ? Number(limitFlag.split("=")[1]) : undefined,
    closePool: true,
  }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
