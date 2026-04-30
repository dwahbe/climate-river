// scripts/verify-jsdom-concurrent.ts
// Stress-tests the prefetch path under concurrent load — the failure mode
// the simple sequential test missed. Spawns N parallel /api/reader/[id]
// requests to fresh articles and looks for the DOMSelector TDZ error that
// shows up when concurrent dynamic imports race during module evaluation.
import { query, endPool } from "@/lib/db";

const SERVER = process.env.TEST_SERVER || "http://127.0.0.1:3001";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

type ReaderResponse =
  | { success: true; data: { wordCount: number }; timing: { elapsed: number } }
  | { success: false; status: string; error: string };

async function pickArticles(n: number) {
  // Pick from publishers we know return 200 OK (so the request reaches jsdom
  // and exercises the race path). Skip Carbon Pulse — most articles 403.
  const { rows } = await query<{
    id: number;
    source: string;
    canonical_url: string;
  }>(
    `
    select a.id,
      coalesce(a.publisher_name, s.name) as source,
      a.canonical_url
    from articles a
    left join sources s on s.id = a.source_id
    where a.content_status = 'error'
      and a.content_error like '%ERR_REQUIRE_ESM%'
      and a.fetched_at >= now() - interval '14 days'
      and a.canonical_url not like 'https://news.google.com%'
      and (
        coalesce(a.publisher_name, s.name) ilike '%Heatmap%'
        or coalesce(a.publisher_name, s.name) ilike '%Guardian%'
        or coalesce(a.publisher_name, s.name) ilike '%Down To Earth%'
        or coalesce(a.publisher_name, s.name) ilike '%Mongabay%'
        or coalesce(a.publisher_name, s.name) ilike '%CleanTechnica%'
        or coalesce(a.publisher_name, s.name) ilike '%Inside Climate%'
        or coalesce(a.publisher_name, s.name) ilike '%Phys.org%'
      )
    order by random()
    limit $1
    `,
    [n],
  );
  return rows;
}

async function reset(ids: number[]) {
  await query(
    `update articles
     set content_status = null, content_error = null, content_fetched_at = null
     where id = any($1)`,
    [ids],
  );
}

async function callReader(id: number) {
  const start = Date.now();
  try {
    const res = await fetch(`${SERVER}/api/reader/${id}`, {
      signal: AbortSignal.timeout(25000),
    });
    const body = (await res.json()) as ReaderResponse;
    return { id, body, elapsed: Date.now() - start };
  } catch (e) {
    return {
      id,
      body: {
        success: false,
        status: "fetch_error",
        error: e instanceof Error ? e.message : String(e),
      } as ReaderResponse,
      elapsed: Date.now() - start,
    };
  }
}

async function main() {
  console.log(`\n🧪 Concurrent stress test — ${CONCURRENCY} parallel fetches against ${SERVER}\n`);

  try {
    await fetch(SERVER, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error("  ✗ server not reachable");
    process.exit(2);
  }

  const articles = await pickArticles(CONCURRENCY);
  if (articles.length < 2) {
    console.log("  not enough error rows to stress test");
    return;
  }

  console.log(`  test set (${articles.length} articles):`);
  for (const a of articles)
    console.log(`    [${a.id}] ${a.source.padEnd(20).slice(0, 20)} ${a.canonical_url}`);
  console.log("");

  await reset(articles.map((a) => a.id));
  console.log("  reset → kicking off parallel requests ...\n");

  const t0 = Date.now();
  const results = await Promise.all(articles.map((a) => callReader(a.id)));
  const totalMs = Date.now() - t0;

  console.log("─".repeat(80));
  console.log("RESULTS");
  console.log("─".repeat(80));

  let ok = 0, tdz = 0, jsdom = 0, classified = 0, otherErr = 0;
  for (const r of results) {
    if (r.body.success) {
      console.log(`  ✓ [${r.id}] SUCCESS  ${r.body.data.wordCount} words  ${r.elapsed}ms`);
      ok++;
    } else {
      const e = r.body.error || "";
      const tag = e.includes("DOMSelector")
        ? (tdz++, "✗ TDZ")
        : e.includes("ERR_REQUIRE_ESM")
          ? (jsdom++, "✗ JSDOM")
          : ["blocked", "paywall", "timeout", "not_found"].includes(r.body.status)
            ? (classified++, `· ${r.body.status}`)
            : (otherErr++, "⚠ OTHER");
      console.log(`  ${tag} [${r.id}] ${r.body.status} — ${e.slice(0, 80)}`);
    }
  }

  console.log("─".repeat(80));
  console.log(`  total ${totalMs}ms`);
  console.log(`  ok=${ok}  tdz=${tdz}  jsdom-esm=${jsdom}  classified=${classified}  other=${otherErr}`);

  if (tdz > 0 || jsdom > 0) {
    console.log("\n  ✗ FIX INCOMPLETE — concurrency race still triggering module-load errors.");
    process.exit(1);
  }
  console.log("\n  ✅ No race-condition errors. Concurrent prefetch is safe.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => endPool());
