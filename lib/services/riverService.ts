// lib/services/riverService.ts
import { getClustersForRiver } from "@/lib/repositories/clusterRepository";
import type {
  Cluster,
  ClusterArticle,
  RiverFilters,
  SubLink,
} from "@/lib/models/cluster";

/**
 * Get river data for the homepage
 * This is the main service function that orchestrates data fetching
 */
export async function getRiverData(filters: RiverFilters): Promise<Cluster[]> {
  // Validate filters
  validateFilters(filters);

  try {
    // Fetch clusters from repository
    const clusters = await getClustersForRiver(filters);

    return normalizeRiverClusters(clusters);
  } catch (error) {
    console.error("Service error in getRiverData:", error);

    // During build/prerender, return empty array so the build succeeds.
    // ISR will populate the page on the first real request.
    if (process.env.NEXT_PHASE === "phase-production-build") {
      console.warn("Returning empty clusters during build (upstream unreachable)");
      return [];
    }

    throw error;
  }
}

/**
 * Normalize raw cluster data for the river view by consolidating secondary
 * sources and annotating them with article counts.
 */
export function normalizeRiverClusters(clusters: Cluster[]): Cluster[] {
  return clusters.map((cluster) => normalizeCluster(cluster));
}

function normalizeCluster(cluster: Cluster): Cluster {
  const subs = cluster.subs ?? [];

  if (subs.length === 0) {
    return {
      ...cluster,
      subs: [],
      subs_total: 0,
    };
  }

  const articleIndex = buildArticleIndex(cluster.all_articles_by_source);
  const deduped = new Map<
    string,
    {
      sub: SubLink;
      latestPublishedAt?: string;
      articleCountFromMap?: number;
    }
  >();
  const occurrenceCounts = new Map<string, number>();

  for (const sub of subs) {
    const articleEntry = findArticleEntry(articleIndex, sub);
    const fallbackHost = hostFrom(sub.url);
    const sourceCandidate =
      articleEntry?.key || sub.source || fallbackHost || "";
    const resolvedSource = sourceCandidate.trim() || null;
    const normalizedKey = normalizeSourceName(sourceCandidate);
    const articleCountFromMap = articleEntry?.articles.length;

    if (normalizedKey) {
      occurrenceCounts.set(
        normalizedKey,
        (occurrenceCounts.get(normalizedKey) ?? 0) + 1,
      );
    }

    const enrichedSub: SubLink = {
      ...sub,
      source: resolvedSource,
    };

    const existing = normalizedKey ? deduped.get(normalizedKey) : undefined;

    if (!existing && normalizedKey) {
      deduped.set(normalizedKey, {
        sub: enrichedSub,
        latestPublishedAt: sub.published_at,
        articleCountFromMap,
      });
      continue;
    }

    if (existing && normalizedKey) {
      if (isLater(sub.published_at, existing.latestPublishedAt)) {
        existing.sub = enrichedSub;
        existing.latestPublishedAt = sub.published_at;
      }

      if (!existing.articleCountFromMap && articleCountFromMap) {
        existing.articleCountFromMap = articleCountFromMap;
      }

      continue;
    }

    // Fallback for entries without a normalized key; keep them as-is.
    const fallbackKey = `${sub.article_id}`;
    const fallbackExisting = deduped.get(fallbackKey);

    if (!fallbackExisting) {
      deduped.set(fallbackKey, {
        sub: enrichedSub,
        latestPublishedAt: sub.published_at,
        articleCountFromMap,
      });
      occurrenceCounts.set(
        fallbackKey,
        (occurrenceCounts.get(fallbackKey) ?? 0) + 1,
      );
    } else {
      if (isLater(sub.published_at, fallbackExisting.latestPublishedAt)) {
        fallbackExisting.sub = enrichedSub;
        fallbackExisting.latestPublishedAt = sub.published_at;
      }

      if (!fallbackExisting.articleCountFromMap && articleCountFromMap) {
        fallbackExisting.articleCountFromMap = articleCountFromMap;
      }

      occurrenceCounts.set(
        fallbackKey,
        (occurrenceCounts.get(fallbackKey) ?? 0) + 1,
      );
    }
  }

  const dedupedSubs = Array.from(deduped.entries()).map(
    ([normalizedKey, entry]) => {
      const count =
        entry.articleCountFromMap ?? occurrenceCounts.get(normalizedKey) ?? 1;

      return {
        ...entry.sub,
        article_count: count,
      };
    },
  );

  return {
    ...cluster,
    subs: dedupedSubs,
    subs_total: dedupedSubs.length,
  };
}

/**
 * Validate river filters
 * Ensures the filters are valid before passing to repository
 */
function validateFilters(filters: RiverFilters): void {
  // Validate view
  const validViews = ["latest", "top"];
  const validCategories = [
    "justice",
    "government",
    "business",
    "tech",
    "impacts",
    "research",
  ];

  // If it's not a standard view, check if it's a valid category
  if (!validViews.includes(filters.view)) {
    if (filters.category && !validCategories.includes(filters.category)) {
      throw new Error(`Invalid category: ${filters.category}`);
    }
  }

  // Validate window hours if provided
  if (filters.windowHours !== undefined) {
    if (filters.windowHours < 1 || filters.windowHours > 720) {
      throw new Error("Window hours must be between 1 and 720 (30 days)");
    }
  }

  // Validate limit if provided
  if (filters.limit !== undefined) {
    if (filters.limit < 1 || filters.limit > 100) {
      throw new Error("Limit must be between 1 and 100");
    }
  }
}

type ArticleIndexEntry = {
  key: string;
  normalizedKey: string;
  articles: ClusterArticle[];
};

function buildArticleIndex(
  allArticles?: Record<string, ClusterArticle[]> | null,
): Map<string, ArticleIndexEntry> {
  const index = new Map<string, ArticleIndexEntry>();

  if (!allArticles) {
    return index;
  }

  for (const [key, articles] of Object.entries(allArticles)) {
    const normalizedKey = normalizeSourceName(key);

    if (!normalizedKey) {
      continue;
    }

    index.set(normalizedKey, {
      key,
      normalizedKey,
      articles,
    });
  }

  return index;
}

function findArticleEntry(
  index: Map<string, ArticleIndexEntry>,
  sub: SubLink,
): ArticleIndexEntry | undefined {
  const candidates: string[] = [];

  if (sub.source) {
    candidates.push(sub.source);
  }

  const host = hostFrom(sub.url);

  if (host) {
    candidates.push(host);
  }

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSourceName(candidate);

    if (!normalizedCandidate) {
      continue;
    }

    const exact = index.get(normalizedCandidate);

    if (exact) {
      return exact;
    }
  }

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSourceName(candidate);

    if (!normalizedCandidate) {
      continue;
    }

    for (const entry of index.values()) {
      if (
        entry.normalizedKey.includes(normalizedCandidate) ||
        normalizedCandidate.includes(entry.normalizedKey)
      ) {
        return entry;
      }
    }
  }

  return undefined;
}

function hostFrom(url: string): string {
  if (!url) {
    return "";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeSourceName(value?: string | null): string {
  return value
    ? value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
    : "";
}

function isLater(candidate: string, current?: string): boolean {
  if (!current) {
    return true;
  }

  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);

  if (Number.isNaN(candidateTime)) {
    return false;
  }

  if (Number.isNaN(currentTime)) {
    return true;
  }

  return candidateTime > currentTime;
}
