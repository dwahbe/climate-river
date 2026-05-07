// lib/repositories/leaderboardRepository.ts
import * as DB from "@/lib/db";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";

export type LeaderboardEntry = {
  name: string;
  homepage: string;
  leads: number;
  articles: number;
  /** Rank change vs previous period: positive = moved up, negative = dropped, null = new */
  change: number | null;
};

export type RawRow = {
  rank_key: string;
  name: string;
  homepage: string;
  leads: number;
  articles: number;
};

/**
 * SQL expression that normalises a URL column to a bare host.
 * Strips scheme, path, port, then removes common non-distinctive prefixes
 * (www, m, mobile, amp, amp-cdn). Preserves news. and edition. so that
 * news.google.com stays distinct and can be excluded correctly.
 */
function sqlNormalizeHost(urlExpr: string): string {
  return `regexp_replace(
      lower(regexp_replace(regexp_replace(
        ${urlExpr},
        '^https?://', ''), '[:/].*$', '')),
      '^(www\\.|m\\.|mobile\\.|amp\\.|amp-cdn\\.)', '')`;
}

const EXCLUDED_HOSTS = `('news.google.com', 'news.yahoo.com', 'msn.com')`;

/**
 * Build a CTE-based leaderboard query that ranks effective publishers,
 * not raw sources rows.
 *
 * $1 = window start offset hours, $2 = window end offset hours
 * $3 = limit (only when withLimit is true)
 */
function buildLeadsQuery(withLimit: boolean) {
  const hostExpr = sqlNormalizeHost(
    `coalesce(nullif(a.publisher_homepage, ''), nullif(s.homepage_url, ''), a.canonical_url)`,
  );

  return `
    WITH effective_articles AS (
      SELECT
        a.id,
        a.published_at,
        ac.cluster_id,
        cs.size                                  AS cluster_size,
        (cs.lead_article_id = a.id)              AS is_lead,
        coalesce(nullif(a.publisher_name, ''), s.name)
                                                 AS publication_name,
        coalesce(nullif(a.publisher_homepage, ''), nullif(s.homepage_url, ''))
                                                 AS publication_homepage,
        ${hostExpr}                              AS publication_host
      FROM articles a
      LEFT JOIN sources s ON s.id = a.source_id
      JOIN article_clusters ac ON a.id = ac.article_id
      JOIN cluster_scores cs  ON ac.cluster_id = cs.cluster_id
      WHERE a.published_at >  NOW() - make_interval(hours => $1)
        AND a.published_at <= NOW() - make_interval(hours => $2)
        AND ${visibleLanguagePredicate("a")}
        AND NOT (
          coalesce(s.slug, '') = 'web-discovery'
          AND nullif(a.publisher_name, '') IS NULL
          AND nullif(a.publisher_homepage, '') IS NULL
        )
    ),
    pub_stats AS (
      SELECT
        CASE
          WHEN publication_host <> ''
            THEN 'host:' || publication_host
          ELSE 'name:' || lower(coalesce(publication_name, 'unknown'))
        END AS rank_key,

        coalesce(
          (array_agg(publication_name ORDER BY published_at DESC)
            FILTER (WHERE publication_name IS NOT NULL
                      AND publication_name <> '')
          )[1],
          max(publication_host)
        ) AS name,

        coalesce(
          (array_agg(publication_homepage ORDER BY published_at DESC)
            FILTER (WHERE publication_homepage IS NOT NULL
                      AND publication_homepage <> '')
          )[1],
          CASE
            WHEN max(publication_host) <> ''
              THEN 'https://' || max(publication_host)
            ELSE ''
          END
        ) AS homepage,

        sum(CASE WHEN is_lead THEN cluster_size ELSE 0 END)::int AS leads,
        count(DISTINCT cluster_id)::int                           AS articles

      FROM effective_articles
      WHERE publication_host NOT IN ${EXCLUDED_HOSTS}
      GROUP BY rank_key
      HAVING bool_or(is_lead)
    )
    SELECT rank_key, name, homepage, leads, articles
    FROM pub_stats
    ORDER BY leads DESC, articles DESC
    ${withLimit ? "LIMIT $3" : ""}`;
}

/**
 * Pure function: compute rank changes from two ordered lists of raw rows.
 * Strips rank_key from the returned entries.
 */
export function computeRankChanges(
  currentRows: RawRow[],
  previousRows: RawRow[],
): LeaderboardEntry[] {
  const prevRankMap = new Map<string, number>();
  previousRows.forEach((row, i) => prevRankMap.set(row.rank_key, i + 1));

  return currentRows.map((row, i) => {
    const currentRank = i + 1;
    const prevRank = prevRankMap.get(row.rank_key);
    // positive = moved up, negative = dropped, null = new to the board
    const change = prevRank != null ? prevRank - currentRank : null;

    return {
      name: row.name,
      homepage: row.homepage,
      leads: row.leads,
      articles: row.articles,
      change,
    };
  });
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
    // Previous: 2x windowHours ago → windowHours ago (no limit for full comparison)
    DB.query<RawRow>(buildLeadsQuery(false), [windowHours * 2, windowHours]),
  ]);

  return computeRankChanges(current.rows, previous.rows);
}
