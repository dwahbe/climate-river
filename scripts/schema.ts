// scripts/schema.ts
import * as DB from '@/lib/db'

/**
 * Idempotent schema for the MVP. No filesystem access.
 * The ingest route (or any script) should call `applySchema()` once before use.
 */
export const SCHEMA_SQL = `
-- SOURCES
create table if not exists sources (
  id            bigserial primary key,
  name          text        not null,
  homepage_url  text,
  feed_url      text unique,
  weight        real        not null default 1,
  created_at    timestamptz not null default now()
);

-- ARTICLES
create table if not exists articles (
  id            bigserial primary key,
  source_id     bigint      not null references sources(id) on delete cascade,
  title         text        not null,
  canonical_url text,
  url           text,
  summary       text,
  hash          text        not null unique,     -- used for de-duping
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists idx_articles_pub         on articles(published_at desc);
create index if not exists idx_articles_source_pub  on articles(source_id, published_at desc);

-- CLUSTERS
create table if not exists clusters (
  id         bigserial primary key,
  key        text        not null unique,        -- stable cluster key from tagger
  created_at timestamptz not null default now()
);

-- ARTICLE ↔ CLUSTER
create table if not exists article_clusters (
  article_id bigint not null references articles(id) on delete cascade,
  cluster_id bigint not null references clusters(id) on delete cascade,
  primary key (article_id, cluster_id)
);
create index if not exists idx_ac_cluster on article_clusters(cluster_id);
create index if not exists idx_ac_article on article_clusters(article_id);

-- SCORES (no sources_count column; we compute it at read time)
create table if not exists cluster_scores (
  cluster_id      bigint primary key references clusters(id) on delete cascade,
  lead_article_id bigint references articles(id) on delete set null,
  size            int    not null default 0,
  score           double precision not null default 0,
  computed_at     timestamptz not null default now(),
  score_notes     text
);
`

/** Call this once at startup (e.g., in ingest) to ensure the schema exists. */
export async function applySchema() {
  await DB.query(SCHEMA_SQL)
}
