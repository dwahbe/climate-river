// scripts/migrate-weights-x2.ts
// One-shot: rescale sources.weight from the legacy 1–5 scale (with manually
// introduced fractionals like 4.5) to the new integer 1–10 scale.
//
// - Round-doubles every existing weight (4.5 → 9, 4 → 8, 1 → 2, etc.).
// - Coerces the column to integer.
// - Sets the column default to 2 (the new "unknown source" baseline).
// - Idempotent: skipped when max(weight) > 5 (already migrated) OR no rows.
//
// Default is dry-run; pass --apply to mutate.
import { query, endPool } from "@/lib/db";

const DRY_RUN = !process.argv.includes("--apply");

type ColInfo = { data_type: string; column_default: string | null };
type WeightRow = { id: number; name: string; weight: number };

async function run() {
  const colInfo = await query<ColInfo>(
    `select data_type, column_default
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'sources'
        and column_name = 'weight'`,
  );
  if (colInfo.rows.length === 0) {
    console.log("❌ sources.weight column not found");
    return;
  }
  const { data_type, column_default } = colInfo.rows[0];
  console.log(
    `📋 Current column: type=${data_type}, default=${column_default}`,
  );

  const stats = await query<{ n: number; max: number | null }>(
    `select count(*)::int as n, max(weight)::float as max from sources`,
  );
  const { n, max } = stats.rows[0];
  console.log(`📊 ${n} rows · current max weight: ${max ?? "n/a"}`);

  if (n === 0) {
    console.log("✅ No rows — nothing to migrate");
    return;
  }
  if (max !== null && max > 5) {
    console.log("✅ Already on the 1–10 scale (max > 5) — skipping");
    return;
  }

  const sample = await query<WeightRow>(
    `select id, name, weight::float as weight
       from sources
      order by weight desc, id
      limit 25`,
  );
  console.log("\n🔍 Top 25 by weight (preview of doubling):");
  for (const r of sample.rows) {
    const next = Math.round(r.weight * 2);
    console.log(`  [${r.id}] ${r.name}: ${r.weight} → ${next}`);
  }

  if (DRY_RUN) {
    console.log("\n🔍 Dry run — pass --apply to write changes");
    return;
  }

  console.log("\n🔄 Doubling all weights and coercing column to int…");
  // Single transaction so we never end up half-migrated.
  await query("begin");
  try {
    await query(
      `update sources set weight = round(weight * 2)::int where weight is not null`,
    );
    await query(
      `alter table sources alter column weight type int using round(weight)::int`,
    );
    await query(`alter table sources alter column weight set default 2`);
    await query("commit");
  } catch (err) {
    await query("rollback");
    throw err;
  }

  const after = await query<{ n: number; max: number; min: number }>(
    `select count(*)::int as n, max(weight)::int as max, min(weight)::int as min from sources`,
  );
  const a = after.rows[0];
  console.log(`✅ Done. ${a.n} rows · weight range now [${a.min}, ${a.max}]`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(() => endPool())
    .catch((err) => {
      console.error(err);
      endPool().finally(() => process.exit(1));
    });
}
