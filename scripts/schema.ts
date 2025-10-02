// scripts/schema.ts
import { query, endPool } from '@/lib/db'

/**
 * Idempotent schema guard.
 * Safe to run repeatedly in local dev, Vercel preview, or production.
 */
export async function run() {
  // --- sources --------------------------------------------------------------
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int  not null default 1,
      slug          text
    );
  `)

  // ensure slug exists & is populated
  await query(
    `alter table if exists sources add column if not exists slug text;`
  )
  await query(`
    update sources
       set slug = regexp_replace(
         lower(coalesce(name, homepage_url, feed_url)),
         '[^a-z0-9]+', '-', 'g'
       )
     where slug is null;
  `)
  await query(`create index if not exists idx_sources_slug on sources(slug);`)

  // --- articles -------------------------------------------------------------
  await query(`
    create table if not exists articles (
      id            bigserial primary key,
      source_id     bigint references sources(id) on delete cascade,
      title         text not null,
      canonical_url text not null unique,
      published_at  timestamptz,
      fetched_at    timestamptz not null default now(),
      dek           text
    );
  `)

  // add columns that may not exist yet
  await query(
    `alter table if exists articles add column if not exists dek text;`
  )

  // Add content columns for Defuddler-fetched article content
  await query(
    `alter table if exists articles add column if not exists content_html text;`
  )
  await query(
    `alter table if exists articles add column if not exists content_text text;`
  )
  await query(
    `alter table if exists articles add column if not exists content_word_count int;`
  )
  await query(
    `alter table if exists articles add column if not exists content_status text;`
  )
  await query(
    `alter table if exists articles add column if not exists content_error text;`
  )
  await query(
    `alter table if exists articles add column if not exists content_fetched_at timestamptz;`
  )

  // Add rewritten title columns
  await query(
    `alter table if exists articles add column if not exists rewritten_title text;`
  )
  await query(
    `alter table if exists articles add column if not exists rewritten_at timestamptz;`
  )
  await query(
    `alter table if exists articles add column if not exists rewrite_model text;`
  )
  await query(
    `alter table if exists articles add column if not exists rewrite_notes text;`
  )

  await query(`
    create index if not exists idx_articles_published_at
      on articles(published_at desc);
  `)
  await query(`
    create index if not exists idx_articles_content_status 
      on articles(content_status) where content_status is not null;
  `)

  // --- clusters -------------------------------------------------------------
  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `)
  // keep a unique index on (key)
  await query(
    `create unique index if not exists idx_clusters_key on clusters(key);`
  )

  // --- article_clusters (link) ---------------------------------------------
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `)

  // --- cluster_scores (for ranking/lead selection) -------------------------
  // Kept minimal: your rescore job can fill/refresh these rows.
  await query(`
    create table if not exists cluster_scores (
      cluster_id      bigint primary key references clusters(id) on delete cascade,
      lead_article_id bigint not null references articles(id) on delete cascade,
      size            int    not null default 1,
      score           double precision not null default 0,
      updated_at      timestamptz not null default now()
    );
  `)
  await query(`
    create index if not exists idx_cluster_scores_score
      on cluster_scores(score desc, updated_at desc);
  `)

  // (Optional) helpful FK indexes (no-ops if they already exist)
  await query(
    `create index if not exists idx_articles_source_id on articles(source_id);`
  )
  await query(
    `create index if not exists idx_article_clusters_cluster_id on article_clusters(cluster_id);`
  )
  await query(
    `create index if not exists idx_article_clusters_article_id on article_clusters(article_id);`
  )

  console.log('Schema ensured ✅')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => endPool())
    .catch((err) => {
      console.error(err)
      endPool().finally(() => process.exit(1))
    })
}
