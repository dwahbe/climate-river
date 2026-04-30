// scripts/reset-jsdom-errors.ts
// One-shot helper: clear `content_status='error'` rows that failed because of
// the jsdom ERR_REQUIRE_ESM bundling bug, so the prefetch cron picks them up
// again on the new (fixed) deploy.
//
// Excludes news.google.com / yahoo / msn aggregator URLs — those have a
// separate failure mode unrelated to jsdom and would just clog the prefetch
// queue if reset.
//
// Default is dry-run. Pass --apply to actually mutate.
import { query, endPool } from "@/lib/db";

const DRY_RUN = !process.argv.includes("--apply");

async function preview() {
  const { rows } = await query<{
    total: number;
    last_24h: number;
    distinct_sources: number;
  }>(`
    select
      count(*)::int as total,
      count(*) filter (where content_fetched_at >= now() - interval '24 hours')::int as last_24h,
      count(distinct coalesce(publisher_name, ''))::int as distinct_sources
    from articles
    where content_status = 'error'
      and (content_error like '%ERR_REQUIRE_ESM%'
           or content_error like '%Failed to load external module jsdom%')
      and fetched_at >= now() - interval '14 days'
      and canonical_url not like 'https://news.google.com%'
      and canonical_url not like 'https://news.yahoo.com%'
      and canonical_url not like 'https://www.msn.com%'
  `);
  return rows[0];
}

async function topSources() {
  const { rows } = await query<{ source: string; n: number }>(`
    select coalesce(a.publisher_name, s.name, 'Unknown') as source,
      count(*)::int as n
    from articles a
    left join sources s on s.id = a.source_id
    where a.content_status = 'error'
      and (a.content_error like '%ERR_REQUIRE_ESM%'
           or a.content_error like '%Failed to load external module jsdom%')
      and a.fetched_at >= now() - interval '14 days'
      and a.canonical_url not like 'https://news.google.com%'
      and a.canonical_url not like 'https://news.yahoo.com%'
      and a.canonical_url not like 'https://www.msn.com%'
    group by 1
    order by n desc
    limit 10
  `);
  return rows;
}

async function apply() {
  const { rowCount } = await query(`
    update articles
    set content_status = null,
        content_error = null,
        content_fetched_at = null
    where content_status = 'error'
      and (content_error like '%ERR_REQUIRE_ESM%'
           or content_error like '%Failed to load external module jsdom%')
      and fetched_at >= now() - interval '14 days'
      and canonical_url not like 'https://news.google.com%'
      and canonical_url not like 'https://news.yahoo.com%'
      and canonical_url not like 'https://www.msn.com%'
  `);
  return rowCount;
}

async function main() {
  console.log(
    `\n🔧 Reset jsdom-ESM error rows  ${DRY_RUN ? "(DRY RUN)" : "(APPLYING)"}\n`,
  );

  const stats = await preview();
  console.log(`  matching rows total .......... ${stats.total}`);
  console.log(`  matching rows fetched <24h ... ${stats.last_24h}`);
  console.log(`  distinct sources ............. ${stats.distinct_sources}`);

  console.log("\n  top sources to be reset:");
  for (const r of await topSources()) {
    console.log(`    ${r.source.padEnd(30).slice(0, 30)} ${r.n}`);
  }

  if (DRY_RUN) {
    console.log("\n  (dry run — pass --apply to execute the UPDATE)\n");
    return;
  }

  const updated = await apply();
  console.log(
    `\n  ✅ reset ${updated} rows. Trigger /api/cron/full to re-prefetch.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => endPool());
