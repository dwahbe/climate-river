-- Migration: Create get_river_clusters function
-- This function encapsulates the complex river query logic

CREATE OR REPLACE FUNCTION get_river_clusters(
  p_is_latest BOOLEAN,
  p_window_hours INT,
  p_limit INT,
  p_category TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  -- Build the river clusters query
  WITH lead AS (
    SELECT
      cs.cluster_id,
      cs.size,
      cs.score,
      a.id AS lead_article_id,
      COALESCE(a.rewritten_title, a.title) AS lead_title,
      a.canonical_url AS lead_url,
      a.dek AS lead_dek,
      a.author AS lead_author,
      a.published_at,
      COALESCE(a.publisher_name, s.name) AS lead_source,
      COALESCE(a.publisher_homepage, s.homepage_url) AS lead_homepage,
      a.content_status AS lead_content_status,
      a.content_word_count AS lead_content_word_count
    FROM cluster_scores cs
    JOIN articles a ON a.id = cs.lead_article_id
    LEFT JOIN sources s ON s.id = a.source_id
    WHERE
      -- Category filtering: check if cluster has ANY article with this category
      (p_category IS NULL OR EXISTS (
        SELECT 1
        FROM article_clusters ac_check
        JOIN article_categories acat ON acat.article_id = ac_check.article_id
        JOIN categories cat ON cat.id = acat.category_id
        WHERE ac_check.cluster_id = cs.cluster_id
          AND cat.slug = p_category
          AND acat.confidence >= 0.3
      ))
      -- Time window filter
      AND (p_is_latest OR a.published_at >= now() - make_interval(hours => p_window_hours))
      -- Exclude aggregators
      AND a.canonical_url NOT LIKE 'https://news.google.com%'
      AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
      AND a.canonical_url NOT LIKE 'https://www.msn.com%'
  )
  SELECT json_agg(
    json_build_object(
      'cluster_id', l.cluster_id,
      'lead_article_id', l.lead_article_id,
      'lead_title', l.lead_title,
      'lead_url', l.lead_url,
      'lead_dek', l.lead_dek,
      'lead_author', l.lead_author,
      'lead_source', l.lead_source,
      'lead_homepage', l.lead_homepage,
      'published_at', l.published_at,
      'size', l.size,
      'score', l.score,
      'lead_content_status', l.lead_content_status,
      'lead_content_word_count', l.lead_content_word_count,
      'sources_count', (
        SELECT COUNT(DISTINCT s.id)
        FROM article_clusters ac
        JOIN articles a2 ON a2.id = ac.article_id
        LEFT JOIN sources s ON s.id = a2.source_id
        WHERE ac.cluster_id = l.cluster_id
      ),
      'subs_total', (
        SELECT COUNT(*)
        FROM article_clusters ac
        JOIN articles a2 ON a2.id = ac.article_id
        WHERE ac.cluster_id = l.cluster_id
          AND a2.id <> l.lead_article_id
      ),
      'subs', (
        WITH x AS (
          SELECT
            a2.id AS article_id,
            a2.title,
            a2.canonical_url AS url,
            COALESCE(a2.publisher_name, s2.name) AS source,
            a2.author,
            a2.published_at,
            COALESCE(
              a2.publisher_host,
              regexp_replace(
                lower(
                  regexp_replace(
                    COALESCE(a2.publisher_homepage, a2.canonical_url),
                    '^https?://([^/]+).*$',
                    '\1'
                  )
                ),
                '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\.',
                ''
              )
            ) AS host_norm
          FROM article_clusters ac2
          JOIN articles a2 ON a2.id = ac2.article_id
          LEFT JOIN sources s2 ON s2.id = a2.source_id
          WHERE ac2.cluster_id = l.cluster_id
            AND a2.id <> l.lead_article_id
        )
        SELECT COALESCE(json_agg(row_to_json(y)), '[]'::json)
        FROM (
          SELECT DISTINCT ON (host_norm)
            article_id, title, url, source, author, published_at
          FROM x
          WHERE url NOT LIKE 'https://news.google.com%'
            AND url NOT LIKE 'https://news.yahoo.com%'
            AND url NOT LIKE 'https://www.msn.com%'
            AND host_norm NOT IN ('news.google.com', 'news.yahoo.com', 'msn.com')
            AND (
              l.size > 1 OR
              host_norm <> (
                SELECT COALESCE(
                  lead_a.publisher_host,
                  regexp_replace(
                    lower(
                      regexp_replace(
                        COALESCE(lead_a.publisher_homepage, lead_a.canonical_url),
                        '^https?://([^/]+).*$',
                        '\1'
                      )
                    ),
                    '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\.',
                    ''
                  )
                )
                FROM articles lead_a
                WHERE lead_a.id = l.lead_article_id
              )
            )
          ORDER BY host_norm, published_at DESC
          LIMIT 8
        ) y
      ),
      'all_articles_by_source', (
        SELECT json_object_agg(source_name, articles)
        FROM (
          SELECT
            COALESCE(a3.publisher_name, s3.name) as source_name,
            json_agg(
              json_build_object(
                'article_id', a3.id,
                'title', COALESCE(a3.rewritten_title, a3.title),
                'url', a3.canonical_url,
                'author', a3.author
              ) ORDER BY a3.published_at DESC
            ) as articles
          FROM article_clusters ac3
          JOIN articles a3 ON a3.id = ac3.article_id
          LEFT JOIN sources s3 ON s3.id = a3.source_id
          WHERE ac3.cluster_id = l.cluster_id
            AND a3.canonical_url NOT LIKE 'https://news.google.com%'
            AND a3.canonical_url NOT LIKE 'https://news.yahoo.com%'
            AND a3.canonical_url NOT LIKE 'https://www.msn.com%'
          GROUP BY COALESCE(a3.publisher_name, s3.name)
          HAVING COUNT(*) > 0
        ) source_groups
      )
    )
    ORDER BY
      CASE WHEN p_is_latest THEN l.published_at END DESC NULLS LAST,
      CASE WHEN NOT p_is_latest THEN l.score END DESC NULLS LAST,
      CASE WHEN NOT p_is_latest THEN (l.cluster_id % 13) END DESC,
      l.cluster_id DESC
    LIMIT p_limit
  ) INTO result
  FROM lead l;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql STABLE;

-- Add helpful comment
COMMENT ON FUNCTION get_river_clusters IS 'Fetches river clusters with all related articles for the homepage. Supports filtering by category, time window, and view mode (latest vs top).';
