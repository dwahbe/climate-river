// scripts/headline-check.ts
// Runs the headline fact-check (lib/headlineCheck.ts) over rewritten headlines
// that are already live. Default is a preview that writes nothing; --apply
// stores the results in headline_checks, for backfilling shadow data.
//
// CLI: bun scripts/headline-check.ts [--apply] [--limit N] [--days N]
//        [--title-only] [--out FILE]

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { endPool, query } from "@/lib/db";
import { median, parseCliArg } from "@/lib/evalCli";
import {
  HeadlineCheckBreaker,
  checkHeadline,
  isHeadlineFlagged,
  storeHeadlineCheck,
  type HeadlineCheck,
} from "@/lib/headlineCheck";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { buildRewriteInputs, type RewriteSourceRow } from "@/lib/rewriteShared";
import { mapLimit } from "@/lib/utils";

const DEFAULT_LIMIT = 40;
const DEFAULT_DAYS = 7;
const CONCURRENCY = 4;

type Options = {
  apply: boolean;
  limit: number;
  days: number;
  titleOnly: boolean;
  out?: string;
  closePool?: boolean;
};

type Row = RewriteSourceRow & {
  id: number | string;
  rewritten_title: string;
  source_name: string | null;
  is_lead: boolean;
};

export type HeadlineCheckRecord = {
  articleId: number;
  source: string | null;
  isLead: boolean;
  hasContent: boolean;
  original: string;
  headline: string;
  check: HeadlineCheck | null;
  flagged: boolean;
  error: string | null;
  latencyMs: number | null;
};

async function tableExists(): Promise<boolean> {
  const { rows } = await query<{ name: string | null }>(
    `select to_regclass('public.headline_checks')::text as name`,
  );
  return rows[0]?.name != null;
}

/** Live rewritten headlines, newest first, in a fixed pseudo-random order. */
async function selectHeadlines(
  opts: Options,
  skipChecked: boolean,
): Promise<Row[]> {
  const { rows } = await query<Row>(
    `
      select a.id, a.title, a.dek, a.content_text, a.content_html,
             a.content_status, a.published_at, a.rewritten_title,
             coalesce(a.publisher_name, s.name) as source_name,
             exists (
               select 1 from cluster_scores cs where cs.lead_article_id = a.id
             ) as is_lead
      from articles a
      left join sources s on s.id = a.source_id
      where a.rewritten_title is not null
        and a.rewritten_at >= now() - make_interval(days => $1)
        and ${visibleLanguagePredicate("a")}
        ${opts.titleOnly ? "and a.content_status is distinct from 'success'" : ""}
        ${
          skipChecked
            ? `and not exists (
                 select 1 from headline_checks hc
                 where hc.article_id = a.id and hc.headline = a.rewritten_title
               )`
            : ""
        }
      order by md5(a.id::text)
      limit $2
    `,
    [opts.days, opts.limit],
  );
  return rows;
}

export async function run(opts: Partial<Options> = {}): Promise<
  | {
      ok: true;
      checked: number;
      failed: number;
      flagged: number;
      records: HeadlineCheckRecord[];
    }
  | { ok: false; error: string }
> {
  const options: Options = {
    apply: opts.apply ?? false,
    limit: Math.max(1, opts.limit ?? DEFAULT_LIMIT),
    days: Math.max(1, opts.days ?? DEFAULT_DAYS),
    titleOnly: opts.titleOnly ?? false,
    out: opts.out,
    closePool: opts.closePool,
  };

  try {
    const hasTable = await tableExists();
    if (options.apply && !hasTable) {
      const error = "headline_checks is missing; run `bun run schema` first";
      console.warn(`⚠️  ${error}`);
      if (options.closePool) await endPool();
      return { ok: false, error };
    }

    const rows = await selectHeadlines(options, hasTable && options.apply);
    console.log(
      `🔎 Checking ${rows.length} live headlines from the last ${options.days}d${options.apply ? "" : " (preview, no writes)"}...`,
    );

    const breaker = new HeadlineCheckBreaker(5);
    const records = await mapLimit(rows, CONCURRENCY, async (row) => {
      const articleId = Number(row.id);
      const { promptInput } = buildRewriteInputs({ ...row, id: articleId });
      const record: HeadlineCheckRecord = {
        articleId,
        source: row.source_name,
        isLead: row.is_lead,
        hasContent: !!promptInput.contentSnippet,
        original: row.title,
        headline: row.rewritten_title,
        check: null,
        flagged: false,
        error: breaker.tripped ? "skipped_after_failures" : null,
        latencyMs: null,
      };
      if (breaker.tripped) return record;

      const started = Date.now();
      try {
        const outcome = await checkHeadline(promptInput, row.rewritten_title, {
          timeoutMs: 15_000,
        });
        breaker.recordSuccess();
        record.check = outcome.check;
        record.flagged = isHeadlineFlagged(outcome.check);
        record.latencyMs = outcome.latencyMs;
        if (options.apply) {
          await storeHeadlineCheck({
            articleId,
            headline: row.rewritten_title,
            hasContent: record.hasContent,
            outcome,
          });
        }
      } catch (error) {
        breaker.recordError();
        record.error = error instanceof Error ? error.message : String(error);
        record.latencyMs = Date.now() - started;
      }
      return record;
    });

    const checked = records.filter((r) => r.check).length;
    const flagged = records.filter((r) => r.flagged);
    const latencies = records
      .filter((r) => r.check)
      .map((r) => r.latencyMs ?? 0);

    for (const record of flagged) {
      console.log(
        `\n  supported ${record.check!.supportedP.toFixed(2)} | invented attribution ${record.check!.inventedAttributionP.toFixed(2)} | ${record.hasContent ? "with content" : "title only"}${record.isLead ? " | LEAD" : ""}\n    was: ${record.original.slice(0, 110)}\n    now: ${record.headline.slice(0, 160)}`,
      );
    }
    console.log(
      `\n✅ Checked ${checked}, failed ${records.length - checked}, would flag ${flagged.length} (${checked ? ((flagged.length / checked) * 100).toFixed(1) : "0"}%), median ${median(latencies) ?? "n/a"}ms`,
    );

    if (options.out) {
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(
        options.out,
        records.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      console.log(`📝 Records written to ${options.out}`);
    }

    if (options.closePool) await endPool();
    return {
      ok: true,
      checked,
      failed: records.length - checked,
      flagged: flagged.length,
      records,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Headline check failed:", message);
    if (options.closePool) await endPool();
    return { ok: false, error: message };
  }
}

function parseCliArgs(argv: string[]): Partial<Options> {
  const opts: Partial<Options> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") {
      opts.apply = true;
      continue;
    }
    if (argv[i] === "--title-only") {
      opts.titleOnly = true;
      continue;
    }
    const out = parseCliArg(argv, i, "--out");
    if (out) {
      opts.out = out.value;
      i += out.skip;
      continue;
    }
    for (const [flag, key] of [
      ["--limit", "limit"],
      ["--days", "days"],
    ] as const) {
      const match = parseCliArg(argv, i, flag);
      if (!match) continue;
      const parsed = Number(match.value);
      if (Number.isFinite(parsed)) opts[key] = Math.max(1, Math.floor(parsed));
      i += match.skip;
      break;
    }
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run({ ...parseCliArgs(process.argv.slice(2)), closePool: true })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error("❌ Fatal error:", error);
      process.exit(1);
    });
}
