// scripts/snapshot-river.ts
// "Golden river" snapshot: dumps the top + latest homepage cluster lists to
// tmp/snapshots/ for before/after diffing of ranking/serving changes. Read-only.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, endPool } from "@/lib/db";

interface RiverRow {
  cluster_id: number;
  size: number;
  score: number;
  sources_count: number;
  lead_title: string;
  lead_was_rewritten: boolean;
  lead_url: string;
  lead_source: string | null;
  published_at: string;
  subs_total: number;
}

async function fetchView(
  isLatest: boolean,
  windowHours: number,
  limit: number,
) {
  const { rows } = await query<RiverRow>(
    `SELECT cluster_id, size, score, sources_count, lead_title,
            lead_was_rewritten, lead_url, lead_source, published_at, subs_total
     FROM get_river_clusters($1, $2, $3, NULL)`,
    [isLatest, windowHours, limit],
  );
  return rows;
}

export async function run(
  opts: { limit?: number; outDir?: string; closePool?: boolean } = {},
) {
  const limit = opts.limit ?? 20;
  const outDir = opts.outDir ?? join(process.cwd(), "tmp", "snapshots");

  const [top, latest] = [
    await fetchView(false, 72, limit),
    await fetchView(true, 168, limit),
  ];

  const snapshot = {
    taken_at: new Date().toISOString(),
    limit,
    top,
    latest,
  };

  mkdirSync(outDir, { recursive: true });
  const stamp = snapshot.taken_at.replace(/[:.]/g, "-");
  const path = join(outDir, `river-${stamp}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));

  console.log(`📸 River snapshot (top ${limit}) → ${path}`);
  for (const row of top) {
    const age = Math.round(
      (Date.now() - new Date(row.published_at).getTime()) / 3_600_000,
    );
    console.log(
      `  ${String(row.score.toFixed(3)).padStart(7)}  sz=${String(row.size).padStart(3)}  ${String(age).padStart(3)}h  ${row.lead_was_rewritten ? "rw" : "--"}  ${row.lead_title.slice(0, 78)}`,
    );
  }

  if (opts.closePool) await endPool();
  return { ok: true as const, path, top: top.length, latest: latest.length };
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const limitFlag = process.argv.find((a) => a.startsWith("--limit="));
  run({
    limit: limitFlag ? Number(limitFlag.split("=")[1]) : undefined,
    closePool: true,
  }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
