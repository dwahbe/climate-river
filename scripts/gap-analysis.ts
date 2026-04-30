// scripts/gap-analysis.ts
// Comprehensive rewrite-pipeline diagnostic. Run before/after the prefetch
// jsdom fix to measure improvement. Mirrors the predicates used by
// get_river_clusters() so the numbers reflect what users actually see.
import { query, endPool } from "@/lib/db";

const HOMEPAGE_LIMIT = 10;
const HOMEPAGE_WINDOW_HOURS = 72;
const CATEGORY_LIMIT = 15;
const CATEGORY_WINDOW_HOURS = 168;

const AFFECTED_SOURCES = [
  "Heatmap",
  "Carbon Pulse",
  "Guardian",
  "NPR",
  "BBC",
  "Phys.org",
  "CleanTechnica",
  "Mongabay",
  "Inside Climate News",
  "Down To Earth",
  "Scientific American",
  "Axios",
];

function pct(n: number | string, d: number | string): string {
  const num = Number(n);
  const den = Number(d);
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function fmtMin(s: string | number | null): string {
  if (s == null) return "—";
  const sec = Number(s);
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

async function homepageGap() {
  const sql = `
    with candidate as (
      select
        cs.cluster_id, cs.score, cs.lead_article_id,
        a.published_at, a.fetched_at,
        a.rewritten_title, a.rewrite_notes, a.rewritten_at,
        a.content_status,
        coalesce(a.publisher_name, s.name) as source
      from cluster_scores cs
      join articles a on a.id = cs.lead_article_id
      left join sources s on s.id = a.source_id
      where a.published_at >= now() - make_interval(hours => ${HOMEPAGE_WINDOW_HOURS})
        and a.canonical_url not like 'https://news.google.com%'
        and a.canonical_url not like 'https://news.yahoo.com%'
        and a.canonical_url not like 'https://www.msn.com%'
        and abs(extract(epoch from (a.published_at - a.fetched_at))) > 60
    ),
    top_n as (
      select * from candidate order by score desc, published_at desc
      limit ${HOMEPAGE_LIMIT}
    )
    select
      count(*)::int as total,
      count(*) filter (where rewritten_title is not null)::int as has_rewrite,
      count(*) filter (where content_status = 'success')::int as has_content,
      count(*) filter (where content_status = 'error')::int as content_error,
      count(*) filter (where content_status is null)::int as content_pending,
      count(*) filter (where content_status in ('paywall','blocked','timeout','not_found'))::int as content_other_fail
    from top_n
  `;
  const { rows } = await query<{
    total: number;
    has_rewrite: number;
    has_content: number;
    content_error: number;
    content_pending: number;
    content_other_fail: number;
  }>(sql);
  return rows[0];
}

async function categoryGap() {
  const sql = `
    with cats as (select id, slug from categories),
    candidate as (
      select cat.slug, cs.score, cs.lead_article_id,
        a.rewritten_title, a.content_status, a.published_at, a.fetched_at
      from cluster_scores cs
      join articles a on a.id = cs.lead_article_id
      join article_categories ag on ag.article_id = a.id and ag.is_primary = true
      join cats cat on cat.id = ag.category_id
      where a.published_at >= now() - make_interval(hours => ${CATEGORY_WINDOW_HOURS})
        and a.canonical_url not like 'https://news.google.com%'
        and a.canonical_url not like 'https://news.yahoo.com%'
        and a.canonical_url not like 'https://www.msn.com%'
        and abs(extract(epoch from (a.published_at - a.fetched_at))) > 60
    ),
    ranked as (
      select c.*, row_number() over (
        partition by slug order by score desc, published_at desc
      ) as rn
      from candidate c
    ),
    top_per_cat as (select * from ranked where rn <= ${CATEGORY_LIMIT})
    select
      slug,
      count(*)::int as total,
      count(*) filter (where rewritten_title is not null)::int as has_rewrite,
      count(*) filter (where content_status = 'success')::int as has_content,
      count(*) filter (where content_status = 'error')::int as content_error
    from top_per_cat
    group by slug order by slug
  `;
  const { rows } = await query<{
    slug: string;
    total: number;
    has_rewrite: number;
    has_content: number;
    content_error: number;
  }>(sql);
  return rows;
}

async function affectedSourceErrorRate() {
  // The list of sources we expect the fix to help. Last 14d window.
  const sql = `
    with src as (
      select coalesce(a.publisher_name, s.name) as source,
        a.content_status
      from articles a
      left join sources s on s.id = a.source_id
      where a.fetched_at >= now() - interval '14 days'
        and coalesce(a.publisher_name, s.name) ilike any (array[${AFFECTED_SOURCES.map((_, i) => `'%' || $${i + 1} || '%'`).join(",")}])
    )
    select source,
      count(*)::int as total,
      count(*) filter (where content_status = 'success')::int as ok,
      count(*) filter (where content_status = 'error')::int as err,
      count(*) filter (where content_status is null)::int as pending
    from src
    group by source
    order by err desc nulls last, total desc
  `;
  const { rows } = await query<{
    source: string;
    total: number;
    ok: number;
    err: number;
    pending: number;
  }>(sql, AFFECTED_SOURCES);
  return rows;
}

async function jsdomErrorCount() {
  // Count of error rows whose error message matches the bundling bug.
  const sql = `
    select
      count(*)::int as jsdom_esm_errors,
      count(*) filter (where content_fetched_at >= now() - interval '24 hours')::int as last_24h,
      count(*) filter (where content_fetched_at >= now() - interval '1 hour')::int as last_1h
    from articles
    where content_status = 'error'
      and (content_error like '%ERR_REQUIRE_ESM%'
           or content_error like '%Failed to load external module jsdom%')
  `;
  const { rows } = await query<{
    jsdom_esm_errors: number;
    last_24h: number;
    last_1h: number;
  }>(sql);
  return rows[0];
}

async function newSuccessSentinel() {
  // Word count distribution for content fetched in last 24h. Regression sentinel:
  // if jsdom returns broken DOMs, word counts crater.
  const sql = `
    select
      count(*)::int as n,
      round(percentile_cont(0.5) within group (order by content_word_count))::int as median_words,
      round(percentile_cont(0.1) within group (order by content_word_count))::int as p10_words,
      max(content_word_count) as max_words
    from articles
    where content_status = 'success'
      and content_fetched_at >= now() - interval '24 hours'
      and content_word_count is not null
  `;
  const { rows } = await query<{
    n: number;
    median_words: number | null;
    p10_words: number | null;
    max_words: number | null;
  }>(sql);
  return rows[0];
}

async function pipelineLatencies() {
  const sql = `
    with stages as (
      select
        extract(epoch from (content_fetched_at - fetched_at)) as ingest_to_prefetch_s,
        extract(epoch from (rewritten_at - content_fetched_at)) as prefetch_to_rewrite_s,
        extract(epoch from (rewritten_at - published_at)) as published_to_rewrite_s
      from articles
      where fetched_at >= now() - interval '7 days'
    )
    select
      round(percentile_cont(0.5) within group (order by ingest_to_prefetch_s) filter (where ingest_to_prefetch_s is not null and ingest_to_prefetch_s >= 0))::numeric as ingest_to_prefetch_med_s,
      round(percentile_cont(0.5) within group (order by prefetch_to_rewrite_s) filter (where prefetch_to_rewrite_s is not null and prefetch_to_rewrite_s >= 0))::numeric as prefetch_to_rewrite_med_s,
      round(percentile_cont(0.5) within group (order by published_to_rewrite_s) filter (where published_to_rewrite_s is not null and published_to_rewrite_s >= 0))::numeric as published_to_rewrite_med_s
    from stages
  `;
  const { rows } = await query<{
    ingest_to_prefetch_med_s: string;
    prefetch_to_rewrite_med_s: string;
    published_to_rewrite_med_s: string;
  }>(sql);
  return rows[0];
}

async function main() {
  const stamp = new Date().toISOString();
  console.log(`\n📊 Rewrite pipeline gap analysis — ${stamp}\n`);

  const [hp, cats, aff, jsdomErr, sentinel, latencies] = await Promise.all([
    homepageGap(),
    categoryGap(),
    affectedSourceErrorRate(),
    jsdomErrorCount(),
    newSuccessSentinel(),
    pipelineLatencies(),
  ]);

  console.log("─".repeat(80));
  console.log("KEY METRICS");
  console.log("─".repeat(80));
  console.log(
    `  homepage Top with rewrite ............ ${hp.has_rewrite}/${hp.total}  (${pct(hp.has_rewrite, hp.total)})`,
  );
  console.log(
    `  homepage Top with content ............ ${hp.has_content}/${hp.total}  (${pct(hp.has_content, hp.total)})`,
  );
  console.log(
    `  homepage Top with content_status=error ${hp.content_error}/${hp.total}`,
  );
  console.log(
    `  jsdom-ESM error rows total ........... ${jsdomErr.jsdom_esm_errors}`,
  );
  console.log(`   ↳ added in last 24h ................. ${jsdomErr.last_24h}`);
  console.log(`   ↳ added in last 1h .................. ${jsdomErr.last_1h}`);
  console.log(
    `  median word count, fetched <24h ...... ${sentinel.median_words ?? "—"}  (n=${sentinel.n})`,
  );

  console.log("\n" + "─".repeat(80));
  console.log("HOMEPAGE TOP 10");
  console.log("─".repeat(80));
  console.log(`  total                ${hp.total}`);
  console.log(
    `  has rewrite          ${hp.has_rewrite}  (${pct(hp.has_rewrite, hp.total)})`,
  );
  console.log(
    `  content success      ${hp.has_content}  (${pct(hp.has_content, hp.total)})`,
  );
  console.log(`  content error        ${hp.content_error}`);
  console.log(`  content pending      ${hp.content_pending}`);
  console.log(`  content other-fail   ${hp.content_other_fail}`);

  console.log("\n" + "─".repeat(80));
  console.log("CATEGORY TOPS (Top 15 each)");
  console.log("─".repeat(80));
  console.log("  slug                  total  rewritten  has-content  errors");
  for (const r of cats) {
    console.log(
      `  ${r.slug.padEnd(20)}  ${String(r.total).padStart(5)}  ${String(r.has_rewrite).padStart(9)}  ${String(r.has_content).padStart(11)}  ${String(r.content_error).padStart(6)}`,
    );
  }

  console.log("\n" + "─".repeat(80));
  console.log("AFFECTED SOURCES (last 14 days, ranked by error count)");
  console.log("─".repeat(80));
  console.log(
    "  source                          total   ok  err  pending  ok%",
  );
  for (const r of aff) {
    const okPct = pct(r.ok, r.total);
    console.log(
      `  ${r.source.padEnd(30).slice(0, 30)}  ${String(r.total).padStart(5)}  ${String(r.ok).padStart(3)}  ${String(r.err).padStart(3)}  ${String(r.pending).padStart(7)}  ${okPct.padStart(5)}`,
    );
  }

  console.log("\n" + "─".repeat(80));
  console.log("PIPELINE LATENCIES (median, last 7d)");
  console.log("─".repeat(80));
  console.log(
    `  ingest → prefetch    ${fmtMin(latencies.ingest_to_prefetch_med_s)}`,
  );
  console.log(
    `  prefetch → rewrite   ${fmtMin(latencies.prefetch_to_rewrite_med_s)}`,
  );
  console.log(
    `  published → rewrite  ${fmtMin(latencies.published_to_rewrite_med_s)}`,
  );

  console.log("\n" + "─".repeat(80));
  console.log("CONTENT-EXTRACTION SENTINEL (regression check)");
  console.log("─".repeat(80));
  console.log(`  successful fetches in last 24h   ${sentinel.n}`);
  console.log(
    `  median word count                ${sentinel.median_words ?? "—"}`,
  );
  console.log(
    `  p10 word count                   ${sentinel.p10_words ?? "—"}`,
  );
  console.log(
    `  max word count                   ${sentinel.max_words ?? "—"}`,
  );
  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => endPool());
