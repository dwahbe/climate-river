// lib/models/cluster.ts

export type SubLink = {
  article_id: number;
  title: string;
  url: string;
  source: string | null;
  author: string | null;
  published_at: string;
  article_count?: number;
};

export type ClusterArticle = {
  article_id: number;
  title: string;
  url: string;
  author: string | null;
};

export type Cluster = {
  cluster_id: number;
  lead_article_id: number;
  lead_title: string;
  lead_was_rewritten: boolean;
  lead_url: string;
  lead_dek: string | null;
  lead_source: string | null;
  lead_homepage: string | null;
  lead_author: string | null;
  published_at: string;
  size: number;
  score: number;
  sources_count: number;
  subs: SubLink[];
  subs_total: number;
  all_articles_by_source: Record<string, ClusterArticle[]>;
  lead_content_status: string | null;
  lead_content_word_count: number | null;
  lead_image: string | null;
};

export type RiverFilters = {
  view: "latest" | "top" | string;
  category?: string;
  windowHours?: number;
  limit?: number;
};
