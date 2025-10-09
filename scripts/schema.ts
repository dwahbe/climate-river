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

  // --- get_river_clusters function -------------------------------------------
  // Drop existing function first (it has different return type)
  await query(
    `DROP FUNCTION IF EXISTS get_river_clusters(boolean,integer,integer,text);`
  )

  await query(`
    create or replace function get_river_clusters(
      p_is_latest boolean default false,
      p_window_hours integer default 168,
      p_limit integer default 10,
      p_category text default null
    )
    returns table (
      cluster_id bigint,
      size integer,
      score double precision,
      sources_count integer,
      lead_article_id bigint,
      lead_title text,
      lead_was_rewritten boolean,
      lead_url text,
      lead_dek text,
      lead_source text,
      lead_homepage text,
      lead_author text,
      published_at timestamptz,
      subs jsonb,
      subs_total integer,
      all_articles_by_source jsonb,
      lead_content_status text,
      lead_content_word_count integer
    )
    language sql
    stable
    as $$
      with candidate_clusters as (
        select
          cs.cluster_id,
          cs.size,
          cs.score,
          cs.lead_article_id,
          a.published_at,
          coalesce(a.rewritten_title, a.title) as lead_title,
          (a.rewritten_title is not null) as lead_was_rewritten,
          a.canonical_url as lead_url,
          a.dek as lead_dek,
          a.author as lead_author,
          coalesce(a.publisher_name, s.name) as lead_source,
          coalesce(a.publisher_homepage, s.homepage_url) as lead_homepage,
          a.content_status as lead_content_status,
          a.content_word_count as lead_content_word_count
        from cluster_scores cs
        join articles a on a.id = cs.lead_article_id
        left join sources s on s.id = a.source_id
        where a.published_at >= now() - make_interval(hours => coalesce(p_window_hours, 168))
          and a.canonical_url not like 'https://news.google.com%'
          and a.canonical_url not like 'https://news.yahoo.com%'
          and a.canonical_url not like 'https://www.msn.com%'
      ),
      category_filtered as (
        select c.*
        from candidate_clusters c
        where p_category is null
           or exists (
             select 1
             from article_clusters ac
             join article_categories ag on ag.article_id = ac.article_id
             join categories cat on cat.id = ag.category_id
             where ac.cluster_id = c.cluster_id
               and cat.slug = p_category
           )
      ),
      ranked as (
        select *
        from (
          select
            c.*,
            row_number() over (
              order by
                case when coalesce(p_is_latest, false) then c.published_at end desc,
                case when not coalesce(p_is_latest, false) then c.score end desc,
                c.published_at desc
            ) as rownum
          from category_filtered c
        ) ranked_inner
        where rownum <= coalesce(nullif(p_limit, 0), 10)
      ),
      cluster_articles as (
        select
          rc.rownum,
          rc.cluster_id,
          rc.lead_article_id,
          ac.article_id,
          coalesce(a.rewritten_title, a.title) as title,
          a.canonical_url as url,
          coalesce(a.publisher_name, s.name) as source_name,
          coalesce(a.publisher_homepage, s.homepage_url) as source_homepage,
          a.author,
          a.published_at,
          lower(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  coalesce(a.publisher_homepage, a.canonical_url),
                  '^https?://([^/]+).*$', '\\\\1'
                ),
                ':[0-9]+$', ''
              ),
              '^(www|m|mobile|amp|amp-cdn|edition|news|beta)\\\\.', ''
            )
          ) as host_norm
        from ranked rc
        join article_clusters ac on ac.cluster_id = rc.cluster_id
        join articles a on a.id = ac.article_id
        left join sources s on s.id = a.source_id
      ),
      subs as (
        select
          rc.cluster_id,
          rc.rownum,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'article_id', ca.article_id,
                'title', ca.title,
                'url', ca.url,
                'source', ca.source_name,
                'author', ca.author,
                'published_at', ca.published_at
              )
              order by ca.published_at desc
            )
            filter (
              where ca.article_id <> rc.lead_article_id
                and ca.url not like 'https://news.google.com%'
                and ca.url not like 'https://news.yahoo.com%'
                and ca.url not like 'https://www.msn.com%'
                and ca.host_norm not in ('news.google.com', 'news.yahoo.com', 'msn.com')
            ),
            '[]'::jsonb
          ) as subs_json,
          coalesce(
            count(*)
            filter (
              where ca.article_id <> rc.lead_article_id
                and ca.url not like 'https://news.google.com%'
                and ca.url not like 'https://news.yahoo.com%'
                and ca.url not like 'https://www.msn.com%'
                and ca.host_norm not in ('news.google.com', 'news.yahoo.com', 'msn.com')
            ),
            0
          )::int as subs_total
        from ranked rc
        left join cluster_articles ca on ca.cluster_id = rc.cluster_id
        group by rc.cluster_id, rc.rownum
      ),
      source_lists as (
        select
          rc.cluster_id,
          rc.rownum,
          ca.source_name,
          jsonb_agg(
            jsonb_build_object(
              'article_id', ca.article_id,
              'title', ca.title,
              'url', ca.url,
              'author', ca.author
            )
            order by ca.published_at desc
          ) as articles
        from ranked rc
        join cluster_articles ca on ca.cluster_id = rc.cluster_id
        where ca.source_name is not null
          and ca.url not like 'https://news.google.com%'
          and ca.url not like 'https://news.yahoo.com%'
          and ca.url not like 'https://www.msn.com%'
          and ca.host_norm not in ('news.google.com', 'news.yahoo.com', 'msn.com')
        group by rc.cluster_id, rc.rownum, ca.source_name
      ),
      source_rollup as (
        select
          cluster_id,
          rownum,
          coalesce(jsonb_object_agg(source_name, articles), '{}'::jsonb) as all_articles_by_source
        from source_lists
        group by cluster_id, rownum
      )
      select
        rc.cluster_id,
        rc.size,
        rc.score,
        (
          select count(distinct s2.id)
          from article_clusters ac2
          join articles a2 on a2.id = ac2.article_id
          left join sources s2 on s2.id = a2.source_id
          where ac2.cluster_id = rc.cluster_id
        )::int as sources_count,
        rc.lead_article_id,
        rc.lead_title,
        rc.lead_was_rewritten,
        rc.lead_url,
        rc.lead_dek,
        rc.lead_source,
        rc.lead_homepage,
        rc.lead_author,
        rc.published_at,
        coalesce(s.subs_json, '[]'::jsonb) as subs,
        coalesce(s.subs_total, 0) as subs_total,
        coalesce(sr.all_articles_by_source, '{}'::jsonb) as all_articles_by_source,
        rc.lead_content_status,
        rc.lead_content_word_count
      from ranked rc
      left join subs s on s.cluster_id = rc.cluster_id and s.rownum = rc.rownum
      left join source_rollup sr on sr.cluster_id = rc.cluster_id and sr.rownum = rc.rownum
      order by rc.rownum;
    $$;
  `)

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
