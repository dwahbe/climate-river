// Source-weight tiers used by ranking (see scripts/rescore.ts).
// Higher weight → higher editorial trust, larger contribution to cluster score.
//
// Scale: integer 1–10. Default for new RSS-discovered sources is 2;
// web-discovery seeds at 4 (default) or 8 (curated).

// Weight assumed when a source row is missing or has no weight. This is the
// single source of truth — rescore, clustering, and cluster-maintenance all
// import it (they previously hardcoded an inconsistent 6/6/3, scoring unknown
// sources as if they were tier-6 outlets).
export const UNKNOWN_SOURCE_WEIGHT = 2;

export const SOURCE_TIERS: Record<string, number> = {
  // Tier 10 — top-of-the-tree wires/papers
  "reuters.com": 10,
  "apnews.com": 10,
  "ft.com": 10,
  "nytimes.com": 10,
  "bloomberg.com": 10,
  "wsj.com": 10,
  "economist.com": 10,

  // Tier 8 — specialty climate desks and senior editorial
  "theguardian.com": 8,
  "washingtonpost.com": 8,
  "carbonbrief.org": 8,
  "insideclimatenews.org": 8,
  "heatmap.news": 8,
  "eenews.net": 8,
  "canarymedia.com": 8,
  "climatechangenews.com": 8,
  "grist.org": 8,
  "mongabay.com": 8,
  "nature.com": 8,
  "science.org": 8,

  // Tier 6 — broad editorial / national outlets
  "bbc.com": 6,
  "bbc.co.uk": 6,
  "npr.org": 6,
  "axios.com": 6,
  "politico.com": 6,
  "scientificamerican.com": 6,
  "nationalgeographic.com": 6,
  "theatlantic.com": 6,
  "vox.com": 6,
  "time.com": 6,
  "theverge.com": 6,
  "wired.com": 6,
  "yaleclimateconnections.org": 6,
  "phys.org": 6,
  "news.un.org": 6,
  "iea.org": 6,
  "wri.org": 6,
  "rmi.org": 6,
  "ember-climate.org": 6,
  "carbon-pulse.com": 6,
  "energymonitor.ai": 6,
  "climate.gov": 6,
  "earthobservatory.nasa.gov": 6,
  "downtoearth.org.in": 6,
  "restofworld.org": 6,
  "weforum.org": 6,
  "project-syndicate.org": 6,

  // Tier 4 — blogs and niche aggregators (still useful, lower trust)
  "cleantechnica.com": 4,
  "electrek.co": 4,
  "treehugger.com": 4,
};

/** Normalize a host string for tier lookup. */
function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^(?:www|m|amp|edition|beta)\./, "");
}

/**
 * Resolve a tier weight for a host or homepage URL.
 * Returns null when the host isn't in the tier map — caller should fall
 * back to its own default (typically 2 for unknown sources).
 */
export function resolveTier(hostOrUrl: string): number | null {
  if (!hostOrUrl) return null;
  const host = normalizeHost(hostOrUrl);
  if (host in SOURCE_TIERS) return SOURCE_TIERS[host];
  // Match against parent domain (e.g. "climate.bloomberg.com" → "bloomberg.com")
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (candidate in SOURCE_TIERS) return SOURCE_TIERS[candidate];
  }
  return null;
}
