// Sources whose every item is on-topic for a climate/energy aggregator.
//
// `isClimateRelevant` (lib/tagger.ts) is a keyword gate tuned for general
// feeds; on climate-only outlets it is pure loss (live check 2026-08-21: it
// dropped ~20% of Grist, 17% of Heatmap, 40–50% of Volts/Heated items —
// "Amtrak's cleaner new trains", "California's tire efficiency rules",
// "Why can't utilities innovate?"). Ingest and web discovery consult this
// module and bypass the gate for trusted sources.
//
// Two kinds of trust, mirroring how outlets publish:
//   - TRUSTED_CLIMATE_HOSTS: the whole outlet is climate/energy (Grist,
//     Heatmap, Carbon Brief…). Matched by host, walking up parent domains
//     like config/sourceTiers.ts (news.example.com → example.com).
//   - TRUSTED_CLIMATE_FEED_PATTERNS: climate *section* feeds of general
//     outlets (Guardian environment, NYT Climate, Vox climate). The same
//     outlet's all-topics feed stays gated.
//
// Dependency-free on purpose (imported by scripts and lib alike).

export const TRUSTED_CLIMATE_HOSTS: readonly string[] = [
  // Climate newsrooms
  "grist.org",
  "heatmap.news",
  "canarymedia.com",
  "carbonbrief.org",
  "insideclimatenews.org",
  "climatechangenews.com",
  "carbon-pulse.com",
  "yaleclimateconnections.org",
  "energymonitor.ai",
  "latitudemedia.com",
  "carbonherald.com",
  "dialogue.earth",
  "desmog.com",
  "drilled.media",
  "floodlightnews.org",
  // Newsletters / blogs
  "volts.wtf",
  "heated.world",
  "distilled.earth",
  "theclimatebrink.com",
  "sustainabilitybynumbers.com",
  "billmckibben.substack.com",
  // Think tanks / agencies / trackers
  "ember-energy.org",
  "ember-climate.org",
  "rmi.org",
  "wri.org",
  "iea.org",
  "ieefa.org",
  "carbontracker.org",
  "climate.gov",
  "climatecasechart.com",
  "climate.law.columbia.edu",
  "climate.copernicus.eu",
  "ncei.noaa.gov",
];

export const TRUSTED_CLIMATE_FEED_PATTERNS: readonly RegExp[] = [
  // Guardian climate/energy subsections only. The broad environment desk
  // (environment/rss, us/environment/rss) and NYT Climate.xml also carry
  // wildlife/outdoors items ("otter spotted in the Bronx", "wild swimming
  // spots") that would become weight-9 leads — those feeds stay gated.
  /theguardian\.com\/environment\/(?:climate-crisis|climate-change|energy|fossil-fuels|renewableenergy|carbon-emissions|wind-power|solarpower|oil|gas|coal)(?:\/|\?|$)/i,
  /vox\.com\/rss\/climate/i,
  /nature\.com\/(?:nclimate|nenergy)\.rss/i,
  /technologyreview\.com\/topic\/climate-change/i,
  /nature\.com\/subjects\/climate-change/i,
  /semafor\.com\/vertical\/net-zero/i,
];

import { normalizeHost } from "./sourceTiers";

const HOST_SET = new Set(TRUSTED_CLIMATE_HOSTS.map((h) => normalizeHost(h)));

/** True when `hostOrUrl` is, or is a subdomain of, a trusted climate host. */
export function isTrustedClimateHost(
  hostOrUrl: string | null | undefined,
): boolean {
  if (!hostOrUrl) return false;
  const host = normalizeHost(hostOrUrl);
  if (!host) return false;
  if (HOST_SET.has(host)) return true;
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (HOST_SET.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/** True when a feed URL is a climate section feed of a general outlet. */
export function isTrustedClimateFeed(
  feedUrl: string | null | undefined,
): boolean {
  if (!feedUrl) return false;
  return TRUSTED_CLIMATE_FEED_PATTERNS.some((re) => re.test(feedUrl));
}

/**
 * Should the climate-relevance gate be bypassed for this source?
 * Pass whichever of feedUrl / homepage host / article URL you have.
 */
export function isTrustedClimateSource(input: {
  feedUrl?: string | null;
  homepageUrl?: string | null;
  url?: string | null;
  host?: string | null;
}): boolean {
  // Only real http(s) feeds carry path information; discovery pseudo-sources
  // (`discover://host`, `web://host`) are judged by their host like any
  // discovered article.
  const feedUrl = input.feedUrl ?? null;
  const isHttpFeed = !!feedUrl && /^https?:\/\//i.test(feedUrl);
  if (isHttpFeed && isTrustedClimateFeed(feedUrl)) return true;
  // A feed on a trusted host is trusted regardless of path (grist.org/feed/).
  if (isHttpFeed && isTrustedClimateHost(feedUrl)) return true;
  if (feedUrl && !isHttpFeed) {
    const pseudoHost = feedUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    if (isTrustedClimateHost(pseudoHost)) return true;
  }
  if (isTrustedClimateHost(input.host)) return true;
  if (isTrustedClimateHost(input.url)) return true;
  // Homepage only counts when no real feed was given: a general http feed
  // hosted on a trusted domain is already covered above; this is for
  // discovered sources.
  if (!isHttpFeed && isTrustedClimateHost(input.homepageUrl)) return true;
  return false;
}
