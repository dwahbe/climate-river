// scripts/schema.ts
import { query, endPool } from "@/lib/db";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { serveTimeScoreSql } from "@/lib/scoring";

/**
 * Idempotent schema guard.
 * Safe to run repeatedly in local dev, Vercel preview, or production.
 */
export async function run() {
  // --- pgvector extension for semantic similarity ---------------------------
  // Use 'extensions' schema to avoid Supabase lint warning
  await query(`create schema if not exists extensions;`);
  await query(`create extension if not exists vector schema extensions;`);

  // --- sources --------------------------------------------------------------
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int  not null default 2,
      slug          text
    );
  `);

  // ensure slug exists & is populated
  await query(
    `alter table if exists sources add column if not exists slug text;`,
  );
  await query(`
    update sources
       set slug = regexp_replace(
         lower(coalesce(name, homepage_url, feed_url)),
         '[^a-z0-9]+', '-', 'g'
       )
     where slug is null;
  `);
  await query(`create index if not exists idx_sources_slug on sources(slug);`);

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
  `);

  // add columns that may not exist yet
  await query(
    `alter table if exists articles add column if not exists dek text;`,
  );

  // Add content columns for Defuddler-fetched article content
  await query(
    `alter table if exists articles add column if not exists content_html text;`,
  );
  await query(
    `alter table if exists articles add column if not exists content_text text;`,
  );
  await query(
    `alter table if exists articles add column if not exists content_word_count int;`,
  );
  await query(
    `alter table if exists articles add column if not exists content_status text;`,
  );
  await query(
    `alter table if exists articles add column if not exists content_error text;`,
  );
  await query(
    `alter table if exists articles add column if not exists content_fetched_at timestamptz;`,
  );
  await query(
    `alter table if exists articles add column if not exists content_image text;`,
  );

  // Per-stage pipeline state (status / attempts / last error / timestamp),
  // e.g. {"categorize":{"status":"no_category","attempts":2,"at":"..."}}.
  // Selection queries gate on attempts so no stage retries forever; a stage
  // becomes eligible again when content_fetched_at passes its last attempt.
  await query(
    `alter table if exists articles add column if not exists pipeline_state jsonb not null default '{}'::jsonb;`,
  );

  // Publisher attribution (set by ingest + discover for Google News items).
  // schema.ts owns these so a fresh DB can define get_river_clusters, which
  // references them, before the first ingest runs.
  await query(
    `alter table if exists articles add column if not exists publisher_name text;`,
  );
  await query(
    `alter table if exists articles add column if not exists publisher_homepage text;`,
  );
  await query(
    `alter table if exists articles add column if not exists author text;`,
  );

  await query(
    `alter table if exists articles add column if not exists language_code text;`,
  );
  await query(
    `alter table if exists articles add column if not exists language_confidence real;`,
  );
  await query(
    `alter table if exists articles add column if not exists language_raw_code text;`,
  );
  await query(
    `alter table if exists articles add column if not exists language_source text;`,
  );
  await query(
    `alter table if exists articles add column if not exists language_checked_at timestamptz;`,
  );

  // Add embedding column for semantic similarity (vector dimension 1536 for text-embedding-3-small)
  await query(
    `alter table if exists articles add column if not exists embedding vector(1536);`,
  );

  // Add rewritten title columns
  await query(
    `alter table if exists articles add column if not exists rewritten_title text;`,
  );
  await query(
    `alter table if exists articles add column if not exists rewritten_at timestamptz;`,
  );
  await query(
    `alter table if exists articles add column if not exists rewrite_model text;`,
  );
  await query(
    `alter table if exists articles add column if not exists rewrite_notes text;`,
  );

  await query(`
    create index if not exists idx_articles_published_at
      on articles(published_at desc);
  `);
  await query(`
    create index if not exists idx_articles_content_status 
      on articles(content_status) where content_status is not null;
  `);
  await query(`
    create index if not exists idx_articles_fetched_at
      on articles(fetched_at desc);
  `);
  await query(`drop index if exists idx_articles_language_code;`);
  await query(`
    create index if not exists idx_articles_non_english_language_code
      on articles(language_code)
      where language_code is not null and language_code <> 'en';
  `);

  // --- clusters -------------------------------------------------------------
  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `);
  // keep a unique index on (key)
  await query(
    `create unique index if not exists idx_clusters_key on clusters(key);`,
  );
  // Clustering v2: persisted centroid + membership stats, maintained
  // incrementally by lib/clustering.ts refreshClusterCentroid (and refreshed
  // by cluster-maintenance). findBestCluster is one HNSW lookup against this
  // instead of re-AVGing every cluster's members per article (~309ms/article).
  await query(
    `alter table clusters add column if not exists centroid vector(1536);`,
  );
  await query(
    `alter table clusters add column if not exists member_count int not null default 0;`,
  );
  await query(
    `alter table clusters add column if not exists last_member_at timestamptz;`,
  );
  await query(
    `alter table clusters add column if not exists centroid_updated_at timestamptz;`,
  );
  await query(`
    create index if not exists idx_clusters_centroid_hnsw
      on clusters using hnsw (centroid vector_cosine_ops);
  `);
  // One-shot backfill for pre-v2 rows (only fills NULL centroids; incremental
  // maintenance owns them afterwards).
  await query(`
    update clusters c
    set centroid = agg.centroid,
        member_count = agg.member_count,
        last_member_at = agg.last_member_at,
        centroid_updated_at = now()
    from (
      select
        ac.cluster_id,
        avg(a.embedding) filter (
          where a.embedding is not null and ${visibleLanguagePredicate("a")}
        ) as centroid,
        count(*)::int as member_count,
        max(a.fetched_at) as last_member_at
      from article_clusters ac
      join articles a on a.id = ac.article_id
      group by ac.cluster_id
    ) agg
    where agg.cluster_id = c.id
      and c.centroid is null;
  `);

  // --- article_clusters (link) ---------------------------------------------
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `);

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
  `);
  // Serve-time freshness columns (see scripts/rescore.ts + get_river_clusters):
  // base_score is the decay-free blend, latest_pub the newest member, why a
  // JSON breakdown of the score components for tuning/debugging.
  await query(
    `alter table cluster_scores add column if not exists base_score double precision not null default 0;`,
  );
  await query(
    `alter table cluster_scores add column if not exists latest_pub timestamptz;`,
  );
  await query(`alter table cluster_scores add column if not exists why text;`);
  await query(`
    create index if not exists idx_cluster_scores_score
      on cluster_scores(score desc, updated_at desc);
  `);
  await query(`
    create index if not exists idx_cluster_scores_latest_pub
      on cluster_scores(latest_pub desc);
  `);

  // (Optional) helpful FK indexes (no-ops if they already exist)
  await query(
    `create index if not exists idx_articles_source_id on articles(source_id);`,
  );
  await query(
    `create index if not exists idx_article_clusters_cluster_id on article_clusters(cluster_id);`,
  );
  await query(
    `create index if not exists idx_article_clusters_article_id on article_clusters(article_id);`,
  );

  // --- categories (new 6-category system) ------------------------------------
  await query(`
    create table if not exists categories (
      id serial primary key,
      slug text unique not null,
      name text not null,
      description text,
      color text
    );
  `);

  await query(`
    create table if not exists article_categories (
      article_id bigint references articles(id) on delete cascade,
      category_id int references categories(id) on delete cascade,
      confidence real default 0.0,
      is_primary boolean default false,
      rule_confidence real default 0.0,
      semantic_confidence real default 0.0,
      confidence_source text,
      reasons jsonb default '[]'::jsonb,
      primary key (article_id, category_id)
    );
  `);

  // Add is_primary column if it doesn't exist (for existing tables)
  await query(`
    alter table if exists article_categories 
    add column if not exists is_primary boolean default false;
  `);
  await query(`
    alter table if exists article_categories
    add column if not exists rule_confidence real default 0.0;
  `);
  await query(`
    alter table if exists article_categories
    add column if not exists semantic_confidence real default 0.0;
  `);
  await query(`
    alter table if exists article_categories
    add column if not exists confidence_source text;
  `);
  await query(`
    alter table if exists article_categories
    add column if not exists reasons jsonb default '[]'::jsonb;
  `);

  await query(
    `create index if not exists idx_article_categories_category_id on article_categories(category_id);`,
  );
  await query(
    `create index if not exists idx_article_categories_article_id on article_categories(article_id);`,
  );
  await query(`
    create index if not exists idx_article_categories_primary_quality
      on article_categories(category_id, confidence desc)
      where is_primary = true;
  `);

  // Insert the 6 categories from lib/tagger.ts
  await query(`
    insert into categories (slug, name, description, color) values
      ('government', 'Government', 'Government policy, regulations, and climate laws', '#3B82F6'),
      ('justice', 'Activism', 'Climate protests, rallies, strikes, and direct action by grassroots movements and activist organizations', '#EC4899'),
      ('business', 'Business', 'Corporate climate action, finance, and market trends', '#06B6D4'),
      ('impacts', 'Impacts', 'Climate effects, extreme weather, and environmental consequences', '#EF4444'),
      ('tech', 'Tech', 'Clean technology, renewables, and climate solutions', '#10B981'),
      ('research', 'Research & Innovation', 'Climate research, studies, and scientific discoveries', '#8B5CF6')
    on conflict (slug) do nothing;
  `);

  // --- pipeline_runs (operational health tracking) ---------------------------
  await query(`
    create table if not exists pipeline_runs (
      id          bigserial primary key,
      job_name    text not null,
      started_at  timestamptz not null default now(),
      finished_at timestamptz,
      duration_ms int,
      status      text not null default 'running',
      stats       jsonb,
      error_msg   text
    );
  `);
  await query(`
    create index if not exists idx_pipeline_runs_job_started
      on pipeline_runs(job_name, started_at desc);
  `);

  // RLS: pipeline_runs is internal-only, block all PostgREST access
  await query(`alter table pipeline_runs enable row level security;`);

  // --- discovery telemetry --------------------------------------------------
  // Per-search and per-candidate records let us compare Tavily, OpenAI web
  // search, and Google News by yield, rejection mode, cost, and latency.
  await query(`
    create table if not exists discovery_searches (
      id                bigserial primary key,
      run_id            text not null,
      pipeline_run_id   bigint references pipeline_runs(id) on delete set null,
      provider          text not null,
      segment           text not null,
      query             text not null,
      requested_domains text[],
      model             text,
      search_depth      text,
      tool_calls        int not null default 0,
      result_count      int not null default 0,
      cost_usd          numeric(12,6),
      latency_ms        int,
      status            text not null default 'success',
      error_msg         text,
      created_at        timestamptz not null default now()
    );
  `);
  await query(`
    create index if not exists idx_discovery_searches_run
      on discovery_searches(run_id, created_at desc);
  `);
  await query(`
    create index if not exists idx_discovery_searches_provider
      on discovery_searches(provider, created_at desc);
  `);
  await query(`
    create index if not exists idx_discovery_searches_pipeline_run
      on discovery_searches(pipeline_run_id) where pipeline_run_id is not null;
  `);
  await query(`alter table discovery_searches enable row level security;`);

  await query(`
    create table if not exists discovery_candidates (
      id                  bigserial primary key,
      discovery_search_id bigint references discovery_searches(id) on delete cascade,
      provider            text not null,
      rank                int,
      title               text not null,
      url                 text not null,
      canonical_url       text,
      host                text,
      published_at        timestamptz,
      raw_published_at    text,
      source_name         text,
      snippet             text,
      accepted            boolean,
      rejection_reason    text,
      article_id          bigint references articles(id) on delete set null,
      duplicate_article_id bigint references articles(id) on delete set null,
      raw                 jsonb,
      created_at          timestamptz not null default now()
    );
  `);
  await query(`
    create index if not exists idx_discovery_candidates_search
      on discovery_candidates(discovery_search_id);
  `);
  await query(`
    create index if not exists idx_discovery_candidates_canonical
      on discovery_candidates(canonical_url);
  `);
  await query(`
    create index if not exists idx_discovery_candidates_provider
      on discovery_candidates(provider, created_at desc);
  `);
  await query(`
    create index if not exists idx_discovery_candidates_accepted
      on discovery_candidates(accepted, created_at desc);
  `);
  await query(`
    create index if not exists idx_discovery_candidates_host_accepted
      on discovery_candidates(host)
      where accepted = true;
  `);
  // FK covering indexes: protect article deletes (cleanup) from per-row scans.
  await query(`
    create index if not exists idx_discovery_candidates_article_id
      on discovery_candidates(article_id) where article_id is not null;
  `);
  await query(`
    create index if not exists idx_discovery_candidates_dup_article_id
      on discovery_candidates(duplicate_article_id) where duplicate_article_id is not null;
  `);
  await query(`alter table discovery_candidates enable row level security;`);

  // --- article_events (engagement tracking) ---------------------------------
  // Click handler at app/api/click/route.ts inserts here; the table is also
  // the substrate for future engagement→ranking feedback (CTR boosts).
  await query(`
    create table if not exists article_events (
      id          bigserial primary key,
      article_id  bigint references articles(id) on delete cascade,
      event       text not null,
      session_id  text,
      occurred_at timestamptz not null default now()
    );
  `);
  await query(`
    create index if not exists idx_article_events_lookup
      on article_events(article_id, event, occurred_at desc);
  `);
  // RLS: internal-only, block PostgREST access
  await query(`alter table article_events enable row level security;`);

  // --- rewrite_attempts (per-attempt rewrite telemetry) ---------------------
  // Captures every model attempt — accepted or rejected — so failure modes
  // are observable without crawling logs.
  await query(`
    create table if not exists rewrite_attempts (
      id                  bigserial primary key,
      article_id          bigint references articles(id) on delete cascade,
      attempt_idx         int not null,
      model               text,
      prompt_tokens       int,
      cached_tokens       int,
      output_tokens       int,
      validation_failures jsonb,
      accepted            boolean,
      latency_ms          int,
      created_at          timestamptz not null default now()
    );
  `);
  await query(`
    create index if not exists idx_rewrite_attempts_article
      on rewrite_attempts(article_id, created_at desc);
  `);
  await query(`
    create index if not exists idx_rewrite_attempts_recent
      on rewrite_attempts(created_at desc);
  `);
  // RLS: internal-only, block PostgREST access
  await query(`alter table rewrite_attempts enable row level security;`);

  // --- source feed health columns -------------------------------------------
  await query(
    `alter table if exists sources add column if not exists last_fetched_at timestamptz;`,
  );
  await query(
    `alter table if exists sources add column if not exists last_fetch_status text;`,
  );
  await query(
    `alter table if exists sources add column if not exists last_fetch_count int;`,
  );

  // --- category embeddings (persist across cold starts) ---------------------
  await query(
    `alter table if exists categories add column if not exists embedding vector(1536);`,
  );

  // --- get_river_clusters function -------------------------------------------
  // Drop existing function first (it has different return type)
  await query(
    `DROP FUNCTION IF EXISTS get_river_clusters(boolean,integer,integer,text);`,
  );

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
      lead_content_word_count integer,
      lead_image text
    )
    language sql
    stable
    set search_path = 'public'
    as $$
      with candidate_clusters as (
        select
          cs.cluster_id,
          cs.size,
          -- Serve-time score: decay-free base_score plus the cluster-freshness
          -- term recomputed against latest_pub at read time, so the homepage
          -- ranking is current at ISR granularity rather than frozen between
          -- rescore runs. Falls back to the stored score for any pre-migration
          -- row. Math shared with rescore via lib/scoring.ts — can't drift.
          ${serveTimeScoreSql("cs.base_score", "cs.latest_pub", "cs.score")} as score,
          cs.lead_article_id,
          coalesce(cs.latest_pub, a.published_at) as activity_at,
          a.published_at,
          coalesce(a.rewritten_title, a.title) as lead_title,
          (a.rewritten_title is not null) as lead_was_rewritten,
          a.canonical_url as lead_url,
          a.dek as lead_dek,
          a.author as lead_author,
          coalesce(a.publisher_name, s.name) as lead_source,
          coalesce(a.publisher_homepage, s.homepage_url) as lead_homepage,
          a.content_status as lead_content_status,
          a.content_word_count as lead_content_word_count,
          a.content_image as lead_image
        from cluster_scores cs
        join articles a on a.id = cs.lead_article_id
        left join sources s on s.id = a.source_id
        -- Window on cluster activity (latest member), NOT the lead's own date —
        -- a developing story with a several-day-old authoritative lead but
        -- fresh follow-ups should stay in the river.
        where coalesce(cs.latest_pub, a.published_at) >= now() - make_interval(hours => coalesce(p_window_hours, 168))
          and ${visibleLanguagePredicate("a")}
          -- Lead eligibility (real publisher URL, trustworthy date) is enforced
          -- in rescore's lead selection; the only clusters whose lead is still
          -- an aggregator are those with no eligible member, which have nothing
          -- displayable — keep hiding just those.
          and a.canonical_url not like 'https://news.google.com%'
          and a.canonical_url not like 'https://news.yahoo.com%'
          and a.canonical_url not like 'https://www.msn.com%'
      ),
      category_matches as (
        select
          ac.cluster_id,
          cat.slug,
          sum(
            case
              when ag.is_primary then ag.confidence
              else ag.confidence * 0.35
            end
          ) as category_score,
          count(*) filter (where ag.is_primary) as primary_matches,
          max(ag.confidence) as max_confidence,
          max(coalesce(ag.rule_confidence, 0)) as max_rule_confidence
        from article_clusters ac
        join articles a_lang on a_lang.id = ac.article_id
        join article_categories ag on ag.article_id = ac.article_id
        join categories cat on cat.id = ag.category_id
        where ${visibleLanguagePredicate("a_lang")}
          and ag.confidence >= 0.35
          and (
            coalesce(ag.rule_confidence, 0) > 0
            or ag.confidence >= 0.65
          )
        group by ac.cluster_id, cat.slug
      ),
      category_filtered as (
        select c.*
        from candidate_clusters c
        where p_category is null
           or exists (
             select 1
             from article_categories ag
             join categories cat on cat.id = ag.category_id
             where ag.article_id = c.lead_article_id
               and cat.slug = p_category
               and ag.is_primary = true
               and ag.confidence >= 0.35
               and (
                 coalesce(ag.rule_confidence, 0) > 0
                 or ag.confidence >= 0.65
               )
           )
           or exists (
             select 1
             from category_matches cm
             where cm.cluster_id = c.cluster_id
               and cm.slug = p_category
               and (
                 (cm.primary_matches >= 2 and cm.category_score >= 1.2)
                 or cm.max_confidence >= 0.75
               )
           )
      ),
      ranked as (
        select *
        from (
          select
            c.*,
            row_number() over (
              order by
                case when coalesce(p_is_latest, false) then c.activity_at end desc,
                case when not coalesce(p_is_latest, false) then c.score end desc,
                c.activity_at desc
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
        where ${visibleLanguagePredicate("a")}
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
            and ${visibleLanguagePredicate("a2")}
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
        rc.lead_content_word_count,
        rc.lead_image
      from ranked rc
      left join subs s on s.cluster_id = rc.cluster_id and s.rownum = rc.rownum
      left join source_rollup sr on sr.cluster_id = rc.cluster_id and sr.rownum = rc.rownum
      order by rc.rownum;
    $$;
  `);

  // --- full-text search for articles -----------------------------------------
  await query(
    `ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS search_vector tsvector;`,
  );

  await query(`
    CREATE OR REPLACE FUNCTION articles_search_vector_update() RETURNS trigger
      LANGUAGE plpgsql
      -- Pinned search_path (clears the function_search_path_mutable advisor).
      -- Must include public because the body references public.sources unqualified.
      SET search_path = public, pg_catalog
    AS $$
    DECLARE
      source_name text;
    BEGIN
      SELECT name INTO source_name FROM sources WHERE id = NEW.source_id;
      NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.rewritten_title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.dek, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.publisher_name, source_name, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.author, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.content_text, '')), 'C');
      RETURN NEW;
    END;
    $$;
  `);

  await query(
    `DROP TRIGGER IF EXISTS articles_search_vector_trigger ON articles;`,
  );
  await query(`
    CREATE TRIGGER articles_search_vector_trigger
      BEFORE INSERT OR UPDATE OF title, rewritten_title, dek, content_text, publisher_name, author, source_id ON articles
      FOR EACH ROW
      EXECUTE FUNCTION articles_search_vector_update();
  `);

  await query(
    `CREATE INDEX IF NOT EXISTS idx_articles_search_vector ON articles USING gin(search_vector);`,
  );

  // --- HNSW index for fast vector similarity search --------------------------
  await query(`
    CREATE INDEX IF NOT EXISTS idx_articles_embedding_hnsw
      ON articles USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  `);

  // Backfill only missing search_vector values in batches. Rewriting every row
  // in one UPDATE can exceed Supabase's statement timeout on larger tables.
  const searchVectorBackfillBatchSize = Number.parseInt(
    process.env.SEARCH_VECTOR_BACKFILL_BATCH_SIZE ?? "250",
    10,
  );
  const backfillBatchSize =
    Number.isFinite(searchVectorBackfillBatchSize) &&
    searchVectorBackfillBatchSize > 0
      ? searchVectorBackfillBatchSize
      : 250;
  const backfillAllSearchVectors =
    process.env.SEARCH_VECTOR_BACKFILL_ALL === "1";

  console.log(
    `Backfilling ${backfillAllSearchVectors ? "all" : "missing"} search vectors...`,
  );
  let backfilled = 0;
  let lastBackfilledArticleId = 0;
  for (;;) {
    const { rows, rowCount } = await query<{ id: string }>(
      `
      WITH batch AS (
        SELECT a.id, s.name AS source_name
        FROM articles a
        LEFT JOIN sources s ON s.id = a.source_id
        WHERE ($2::boolean OR a.search_vector IS NULL)
          AND a.id > $3
        ORDER BY a.id
        LIMIT $1
      )
      UPDATE articles a SET search_vector =
        setweight(to_tsvector('english', coalesce(a.title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(a.rewritten_title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(a.dek, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(a.publisher_name, batch.source_name, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(a.author, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(a.content_text, '')), 'C')
      FROM batch
      WHERE a.id = batch.id
      RETURNING a.id;
    `,
      [backfillBatchSize, backfillAllSearchVectors, lastBackfilledArticleId],
    );

    if (rowCount === 0) break;
    backfilled += rowCount;
    lastBackfilledArticleId = rows.reduce(
      (maxId, row) => Math.max(maxId, Number(row.id)),
      lastBackfilledArticleId,
    );
    console.log(`Backfilled ${backfilled} article search vectors...`);
  }
  console.log(`Backfilled ${backfilled} article search vectors`);

  // --- Deprecated object cleanup -----------------------------------------------
  // get_articles_by_category is no longer called anywhere in the app, but it was
  // left exposed to the anon role as a SECURITY DEFINER RPC (a needless attack
  // surface flagged by the Supabase security advisor). Drop it.
  await query(
    `DROP FUNCTION IF EXISTS get_articles_by_category(text, real, integer);`,
  );

  // --- Cluster health diagnostic view ------------------------------------------
  // security_invoker so the view runs with the querying role's RLS instead of
  // the (privileged) creator's — clears the security_definer_view advisor error.
  await query(`
    CREATE OR REPLACE VIEW cluster_health
    WITH (security_invoker = true) AS
    SELECT
      ac.cluster_id,
      COUNT(*) AS size,
      MIN(a.published_at)::date AS oldest,
      MAX(a.published_at)::date AS newest,
      COUNT(*) FILTER (WHERE a.embedding IS NOT NULL) AS embedded_count,
      COUNT(DISTINCT a.source_id) AS distinct_sources
    FROM article_clusters ac
    JOIN articles a ON a.id = ac.article_id
    GROUP BY ac.cluster_id
    ORDER BY size DESC;
  `);

  console.log("Schema ensured ✅");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => endPool())
    .catch((err) => {
      console.error(err);
      endPool().finally(() => process.exit(1));
    });
}
