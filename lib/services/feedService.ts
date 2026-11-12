// lib/services/feedService.ts
// Data loading and XML rendering for the RSS feed (app/feed.xml/route.ts).
import { getRiverData } from "@/lib/services/riverService";
import type { Cluster } from "@/lib/models/cluster";

const SITE_URL = "https://climateriver.org";
const FEED_LIMIT = 30;
const BUILD_RETRIES = 2;
const BUILD_RETRY_DELAY_MS = 2000;

type LoadFeedOptions = {
  fetchClusters?: () => Promise<Cluster[]>;
  isBuild?: boolean;
  retryDelayMs?: number;
};

/**
 * Clusters for the feed. A failed query rejects, and callers must let it: the
 * route is ISR-cached, so a thrown error keeps the last good feed in place and
 * Next retries on the next request. Swallowing the error and rendering an
 * empty feed got that empty feed cached for the whole revalidate window.
 *
 * The production build is the one place a failure can't surface: there
 * getRiverData returns [] so the build succeeds, which would bake an empty feed
 * into the deployment. Retry a couple of times before accepting that.
 */
export async function loadFeedClusters(
  opts: LoadFeedOptions = {},
): Promise<Cluster[]> {
  const fetchClusters =
    opts.fetchClusters ??
    (() => getRiverData({ view: "top", limit: FEED_LIMIT }));
  const isBuild =
    opts.isBuild ?? process.env.NEXT_PHASE === "phase-production-build";
  const retryDelayMs = opts.retryDelayMs ?? BUILD_RETRY_DELAY_MS;

  let clusters = await fetchClusters();
  for (
    let attempt = 1;
    isBuild && clusters.length === 0 && attempt <= BUILD_RETRIES;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    clusters = await fetchClusters();
  }
  return clusters;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildRssXml(clusters: Cluster[], now = new Date()): string {
  const items = clusters
    .map((cluster) => {
      const pubDate = new Date(cluster.published_at).toUTCString();
      const description = cluster.lead_dek
        ? escapeXml(cluster.lead_dek)
        : `Coverage from ${cluster.sources_count} source${cluster.sources_count === 1 ? "" : "s"}`;

      return `    <item>
      <title>${escapeXml(cluster.lead_title)}</title>
      <link>${SITE_URL}/river/${cluster.cluster_id}</link>
      <guid isPermaLink="true">${SITE_URL}/river/${cluster.cluster_id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
      <source url="${escapeXml(cluster.lead_homepage || cluster.lead_url)}">${escapeXml(cluster.lead_source || "Unknown")}</source>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Climate River - Top Climate News</title>
    <link>${SITE_URL}</link>
    <description>Climate news aggregated from leading outlets like The Guardian, New York Times, and Reuters. Stories organized by topic, ranked for trust and timeliness.</description>
    <language>en-us</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
    <ttl>5</ttl>
    <image>
      <url>${SITE_URL}/ClimateRiver.png</url>
      <title>Climate River</title>
      <link>${SITE_URL}</link>
    </image>
${items}
  </channel>
</rss>`;
}
