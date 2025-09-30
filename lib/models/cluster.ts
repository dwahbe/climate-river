// lib/models/cluster.ts

export type SubLink = {
  article_id: number
  title: string
  url: string
  source: string | null
  author: string | null
  published_at: string
}

export type ClusterArticle = {
  article_id: number
  title: string
  url: string
  author: string | null
}

export type Cluster = {
  cluster_id: number
  lead_article_id: number
  lead_title: string
  lead_url: string
  lead_dek: string | null
  lead_source: string | null
  lead_homepage: string | null
  lead_author: string | null
  published_at: string
  size: number
  score: number
  sources_count: number
  subs: SubLink[]
  subs_total: number
  all_articles_by_source: Record<string, ClusterArticle[]>
}

export type RiverFilters = {
  view: 'latest' | 'top' | string
  category?: string
  windowHours?: number
  limit?: number
}
