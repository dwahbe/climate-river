import type { Cluster } from "./cluster";

export type SearchResult = {
  article_id: number;
  title: string;
  was_rewritten: boolean;
  url: string;
  dek: string | null;
  source: string | null;
  source_homepage: string | null;
  author: string | null;
  published_at: string;
  image: string | null;
  content_status: string | null;
  content_word_count: number | null;
  score: number;
};

export function searchResultToCluster(result: SearchResult): Cluster {
  return {
    cluster_id: result.article_id,
    lead_article_id: result.article_id,
    lead_title: result.title,
    lead_was_rewritten: result.was_rewritten,
    lead_url: result.url,
    lead_dek: result.dek,
    lead_source: result.source,
    lead_homepage: result.source_homepage,
    lead_author: result.author,
    published_at: result.published_at,
    size: 1,
    score: result.score,
    sources_count: 1,
    subs: [],
    subs_total: 0,
    all_articles_by_source: {},
    lead_content_status: result.content_status,
    lead_content_word_count: result.content_word_count,
    lead_image: result.image,
  };
}
