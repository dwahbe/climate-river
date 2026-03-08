// lib/repositories/leaderboardRepository.ts
import * as DB from "@/lib/db";

export type LeaderboardEntry = {
  name: string;
  homepage: string;
  leads: number;
  articles: number;
  /** Rank change vs previous period: positive = moved up, negative = dropped, null = new */
  change: number | null;
};

type RawRow = {
  name: string;
  homepage: string;
  leads: number;
  articles: number;
};

const AGGREGATOR_FILTER = `
  AND s.homepage_url NOT LIKE '%news.google.com%'
  AND s.homepage_url NOT LIKE '%news.yahoo.com%'
  AND s.homepage_url NOT LIKE '%msn.com%'`;

/**
 * Query a single time window for outlet lead counts.
 * $1 = start offset hours (from now), $2 = end offset hours (from now)
 */
function buildLeadsQuery(withLimit: boolean) {
  return `
    SELECT
      s.name,
      s.homepage_url AS homepage,
      COALESCE(SUM(cs.size) FILTER (WHERE cs.lead_article_id = a.id), 0)::int AS leads,
      COUNT(DISTINCT ac.cluster_id)::int AS articles
    FROM articles a
    JOIN sources s ON a.source_id = s.id
    JOIN article_clusters ac ON a.id = ac.article_id
    JOIN cluster_scores cs ON ac.cluster_id = cs.cluster_id
    WHERE a.published_at > NOW() - make_interval(hours => $1)
      AND a.published_at <= NOW() - make_interval(hours => $2)
      ${AGGREGATOR_FILTER}
    GROUP BY s.id, s.name, s.homepage_url
    HAVING COUNT(DISTINCT cs.cluster_id)
      FILTER (WHERE cs.lead_article_id = a.id) > 0
    ORDER BY leads DESC, articles DESC
    ${withLimit ? "LIMIT $3" : ""}`;
}

/**
 * Fetch publication leaderboard with week-over-week rank movement.
 * Compares current period against the previous period of equal length.
 */
export async function getPublicationLeaderboard(
  windowHours = 168,
  limit = 10,
): Promise<LeaderboardEntry[]> {
  const [current, previous] = await Promise.all([
    // Current: last windowHours → now
    DB.query<RawRow>(buildLeadsQuery(true), [windowHours, 0, limit]),
    // Previous: 2x windowHours ago → windowHours ago
    DB.query<RawRow>(buildLeadsQuery(false), [windowHours * 2, windowHours]),
  ]);

  // Build rank map for previous period (1-indexed)
  const prevRankMap = new Map<string, number>();
  previous.rows.forEach((row, i) => prevRankMap.set(row.homepage, i + 1));

  return current.rows.map((row, i) => {
    const currentRank = i + 1;
    const prevRank = prevRankMap.get(row.homepage);
    // positive = moved up, negative = dropped, null = new to the board
    const change = prevRank != null ? prevRank - currentRank : null;

    return { ...row, change };
  });
}
