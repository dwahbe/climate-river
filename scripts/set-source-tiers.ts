// scripts/set-source-tiers.ts
// Re-tier existing rows in `sources` based on config/sourceTiers.ts.
//
// Sources whose host appears in the tier map get their weight set to the
// configured value. Sources not in the map are left untouched, which preserves
// any manual adjustments and the discover-web.ts defaults (2 or 4).
//
// Default is dry-run. Pass --apply to actually mutate.
import { query, endPool } from "@/lib/db";
import { resolveTier } from "@/config/sourceTiers";

const DRY_RUN = !process.argv.includes("--apply");

type SourceRow = {
  id: number;
  name: string;
  homepage_url: string | null;
  feed_url: string;
  weight: number;
};

async function run() {
  const { rows } = await query<SourceRow>(
    `select id, name, homepage_url, feed_url, weight from sources order by id`,
  );

  const updates: { id: number; from: number; to: number; host: string }[] = [];
  for (const row of rows) {
    const target =
      resolveTier(row.homepage_url || "") ??
      resolveTier(row.feed_url) ??
      resolveTier(row.name);
    if (target === null) continue;
    if (target === row.weight) continue;
    updates.push({
      id: row.id,
      from: row.weight,
      to: target,
      host: row.homepage_url || row.feed_url || row.name,
    });
  }

  console.log(
    `📊 ${rows.length} sources scanned · ${updates.length} weight changes`,
  );
  if (updates.length === 0) {
    console.log("✅ Nothing to do");
    return;
  }

  for (const u of updates) {
    console.log(`  [${u.id}] ${u.host}: ${u.from} → ${u.to}`);
  }

  if (DRY_RUN) {
    console.log("\n🔍 Dry run — pass --apply to write changes");
    return;
  }

  for (const u of updates) {
    await query(`update sources set weight = $1 where id = $2`, [u.to, u.id]);
  }
  console.log(`\n✅ Applied ${updates.length} weight updates`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => endPool())
    .catch((err) => {
      console.error(err);
      endPool().finally(() => process.exit(1));
    });
}
