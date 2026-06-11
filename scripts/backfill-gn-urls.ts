// scripts/backfill-gn-urls.ts
// Resolve existing news.google.com redirect articles to real publisher URLs.
// For each resolved article: canonical_url is replaced, the source row is
// re-pointed at the real host, and content_status is reset so prefetch retries
// with the real URL. If the resolved URL already exists on another article,
// the GN row is a duplicate and is deleted (cascades clean the junctions;
// cleanup removes any orphaned cluster).
//
//   bun run gn:backfill            # dry-run, newest 50
//   bun scripts/backfill-gn-urls.ts --apply --limit 200 --days 7

import { query, endPool } from "@/lib/db";
import { resolveGoogleNewsUrl } from "@/lib/googleNews";
import { canonical } from "@/lib/utils";
import { resolveTier } from "@/config/sourceTiers";

const THROTTLE_MS = 1_200;

function slugify(input: string) {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

async function upsertSourceForHost(host: string): Promise<number> {
  const name = host.replace(/^www\./, "");
  const { rows } = await query<{ id: number }>(
    `insert into sources (name, homepage_url, feed_url, weight, slug)
     values ($1, $2, $3, $4, $5)
     on conflict (feed_url) do update set name = excluded.name
     returning id`,
    [
      name,
      `https://${name}`,
      `discover://${name}`,
      resolveTier(name) ?? 2,
      slugify(name),
    ],
  );
  return rows[0].id;
}

export async function run(
  opts: {
    limit?: number;
    days?: number;
    apply?: boolean;
    closePool?: boolean;
  } = {},
) {
  const limit = opts.limit ?? 50;
  const days = opts.days ?? 45;
  const apply = opts.apply ?? false;

  console.log(
    `🔗 GN URL backfill — ${apply ? "APPLY" : "DRY RUN"}, newest ${limit} within ${days}d`,
  );

  const { rows } = await query<{
    id: number;
    canonical_url: string;
    title: string;
  }>(
    `select id, canonical_url, title
     from articles
     where canonical_url like 'https://news.google.com%'
       and fetched_at >= now() - make_interval(days => $1)
     order by fetched_at desc
     limit $2`,
    [days, limit],
  );
  console.log(`  Found ${rows.length} unresolved GN articles`);

  let resolved = 0;
  let unresolved = 0;
  let merged = 0;
  let updated = 0;

  for (const r of rows) {
    const res = await resolveGoogleNewsUrl(r.canonical_url);
    if (!res.url || res.method === "passthrough" || res.method === null) {
      unresolved++;
      console.log(`  ✗ [${r.id}] unresolved: ${r.title.slice(0, 60)}`);
    } else {
      resolved++;
      const realUrl = canonical(res.url);
      let host = "";
      try {
        host = new URL(realUrl).hostname;
      } catch {
        unresolved++;
        continue;
      }
      console.log(`  ✓ [${r.id}] ${res.method} → ${realUrl.slice(0, 80)}`);

      if (apply) {
        const dupe = await query<{ id: number }>(
          `select id from articles where canonical_url = $1 and id <> $2 limit 1`,
          [realUrl, r.id],
        );
        if (dupe.rows.length > 0) {
          // Same story already ingested via a direct path — GN row is a duplicate.
          await query(`delete from articles where id = $1`, [r.id]);
          merged++;
        } else {
          const sid = await upsertSourceForHost(host);
          await query(
            `update articles
             set canonical_url = $1,
                 source_id = $2,
                 content_status = null,
                 content_error = null
             where id = $3`,
            [realUrl, sid, r.id],
          );
          updated++;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
  }

  const summary = {
    scanned: rows.length,
    resolved,
    unresolved,
    updated,
    merged,
    apply,
  };
  console.log(`\n📊 Backfill summary:`, summary);
  if (opts.closePool) await endPool();
  return summary;
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split("=")[1]) : undefined;
  };
  run({
    apply: argv.includes("--apply"),
    limit: flag("limit"),
    days: flag("days"),
    closePool: true,
  }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
