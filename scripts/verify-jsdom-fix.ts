// scripts/verify-jsdom-fix.ts
// Hits the local production server's /api/reader/[id] for one currently-erroring
// article from each of the affected publishers. Resets their content_status to
// NULL first so the route does a live fetch (otherwise it returns cached error).
//
// PASS criterion: route returns success with real content for all 3.
// FAIL criterion: route returns the ERR_REQUIRE_ESM jsdom error (i.e. fix didn't take).
import { query, endPool } from "@/lib/db";

const SERVER = process.env.TEST_SERVER || "http://127.0.0.1:3001";
const TEST_SOURCES = ["Heatmap", "Carbon Pulse", "Guardian"];

type ReaderResponse =
  | {
      success: true;
      data: {
        content: string;
        title: string;
        wordCount: number;
      };
      fromCache: boolean;
      timing: { elapsed: number };
    }
  | {
      success: false;
      status: string;
      error: string;
      fromCache: boolean;
    };

async function pickTestArticles() {
  const rows: Array<{ id: number; source: string; canonical_url: string }> = [];
  for (const src of TEST_SOURCES) {
    const { rows: r } = await query<{
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
        and (coalesce(a.publisher_name, s.name) ilike $1)
        and a.content_error like '%ERR_REQUIRE_ESM%'
        and a.fetched_at >= now() - interval '7 days'
      order by a.fetched_at desc
      limit 1
      `,
      [`%${src}%`],
    );
    if (r[0]) rows.push(r[0]);
  }
  return rows;
}

async function resetForTest(ids: number[]) {
  await query(
    `update articles
     set content_status = null, content_error = null, content_fetched_at = null
     where id = any($1)`,
    [ids],
  );
}

async function callReader(
  id: number,
): Promise<ReaderResponse | { error: string }> {
  try {
    const res = await fetch(`${SERVER}/api/reader/${id}`, {
      signal: AbortSignal.timeout(20000),
    });
    return (await res.json()) as ReaderResponse;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  console.log(`\n🧪 Testing prefetch path against ${SERVER}\n`);

  // Quick health check
  try {
    const r = await fetch(SERVER, { signal: AbortSignal.timeout(3000) });
    console.log(`  server up: ${r.status}\n`);
  } catch (e) {
    console.error(
      `  ✗ server not reachable: ${e instanceof Error ? e.message : e}`,
    );
    process.exit(2);
  }

  const articles = await pickTestArticles();
  if (articles.length === 0) {
    console.log(
      "  no erroring articles found in last 7d — fix may already be working in prod, or no recent errors",
    );
    return;
  }

  console.log("  test set:");
  for (const a of articles) {
    console.log(`    [${a.id}] ${a.source}  ${a.canonical_url}`);
  }
  console.log("");

  console.log("  resetting content_status for test articles ...");
  await resetForTest(articles.map((a) => a.id));
  console.log("  done\n");

  console.log("─".repeat(80));
  console.log("RESULTS");
  console.log("─".repeat(80));

  let passes = 0;
  let jsdomFails = 0;
  let otherFails = 0;
  for (const a of articles) {
    const result = await callReader(a.id);
    if ("error" in result && !("status" in result)) {
      console.log(`  ✗ [${a.id}] ${a.source}: HTTP error — ${result.error}`);
      otherFails++;
      continue;
    }
    if (result.success) {
      console.log(
        `  ✓ [${a.id}] ${a.source}: SUCCESS  ${result.data.wordCount} words  ${result.timing.elapsed}ms`,
      );
      passes++;
    } else {
      const isJsdom =
        result.error?.includes("ERR_REQUIRE_ESM") ||
        result.error?.includes("Failed to load external module jsdom");
      const tag = isJsdom ? "✗ JSDOM-BUG" : "⚠ OTHER";
      console.log(
        `  ${tag} [${a.id}] ${a.source}: ${result.status} — ${result.error?.slice(0, 100)}`,
      );
      if (isJsdom) jsdomFails++;
      else otherFails++;
    }
  }

  console.log("─".repeat(80));
  console.log(
    `  ${passes}/${articles.length} successful, ${jsdomFails} jsdom-bug failures, ${otherFails} other failures`,
  );
  console.log("");

  if (jsdomFails > 0) {
    console.log(
      "  ✗ FIX DID NOT TAKE — jsdom ERR_REQUIRE_ESM is still hitting the bundled artifact.",
    );
    process.exit(1);
  }
  if (passes === articles.length) {
    console.log(
      "  ✅ FIX VERIFIED — all 3 affected publishers now extract content via the production bundle.",
    );
  } else {
    console.log(
      "  ⚠ Mixed results — fix worked for some but not all. Review individual failures (could be real publisher blocks, paywalls, etc).",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => endPool());
