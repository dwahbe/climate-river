// scripts/invalidate-reader-junk.ts
// Reset cached reader content that is dominated by link text — the footprint
// of the pre-fix Defuddle fallback that returned whole pages of site chrome
// (see lib/domSelectorCompat.ts). Cleared articles refetch on next reader
// open or prefetch run, going through the fixed extraction pipeline.
//
// --all clears cached extractions whether or not they are link-dense (still
// capped by --limit, newest first) — density can't catch full-page fallbacks
// diluted by long articles, or bodies truncated by the old stripLeadingImage.
// It was the one-off flush after the extraction fix shipped (2026-06-12).
//
//   bun run reader:invalidate              # dry-run
//   bun scripts/invalidate-reader-junk.ts --apply --limit=2000
//   bun run reader:invalidate:apply --all  # ignore link density (newest --limit)

import { query, endPool } from "@/lib/db";
import { parseNumberFlag } from "@/lib/evalCli";
import { linkTextDensity } from "@/lib/services/readerService";

const LINK_DENSITY_LIMIT = 0.5;

export async function run(
  opts: {
    limit?: number;
    apply?: boolean;
    all?: boolean;
    closePool?: boolean;
  } = {},
) {
  const limit = opts.limit ?? 5000;
  const apply = opts.apply ?? false;
  const all = opts.all ?? false;

  console.log(
    `🧹 Reader junk invalidation — ${apply ? "APPLY" : "DRY RUN"}${all ? ", ALL cached extractions" : ""}, newest ${limit} cached articles`,
  );

  const { rows } = await query<{
    id: number;
    canonical_url: string;
    content_html: string;
    content_word_count: number | null;
  }>(
    `
    SELECT id, canonical_url, content_html, content_word_count
    FROM articles
    WHERE content_status = 'success'
      AND content_html IS NOT NULL
    ORDER BY content_fetched_at DESC NULLS LAST
    LIMIT $1
  `,
    [limit],
  );

  const junk: Array<{ id: number; url: string; density: number }> = [];
  for (const row of rows) {
    const words = row.content_word_count ?? 0;
    const density = linkTextDensity(row.content_html, words);
    if (all || density > LINK_DENSITY_LIMIT) {
      junk.push({ id: row.id, url: row.canonical_url, density });
    }
  }

  console.log(`Scanned ${rows.length}, flagged ${junk.length}`);
  for (const item of junk.slice(0, 20)) {
    console.log(`  #${item.id} density=${item.density.toFixed(2)} ${item.url}`);
  }
  if (junk.length > 20) console.log(`  … and ${junk.length - 20} more`);

  if (apply && junk.length > 0) {
    await query(
      `
      UPDATE articles
      SET content_html = NULL,
          content_text = NULL,
          content_word_count = NULL,
          content_status = NULL,
          content_error = NULL,
          content_image = NULL,
          content_fetched_at = NULL
      WHERE id = ANY($1)
    `,
      [junk.map((item) => item.id)],
    );
    console.log(`✅ Cleared cached content for ${junk.length} articles`);
  } else if (junk.length > 0) {
    console.log("Dry run — pass --apply to clear these");
  }

  const summary = { scanned: rows.length, flagged: junk.length, apply };
  if (opts.closePool) await endPool();
  return summary;
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  run({
    apply: argv.includes("--apply"),
    all: argv.includes("--all"),
    limit: parseNumberFlag(argv, "limit"),
    closePool: true,
  }).catch((err) => {
    console.error(err);
    endPool().finally(() => process.exit(1));
  });
}
