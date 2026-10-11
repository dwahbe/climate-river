// scripts/judge-report.ts
// Read-only. Compares the shadow judgments in article_judgments with what
// production decided, so the switch-over can be made on evidence.
//
// CLI: bun scripts/judge-report.ts [--days N] [--out-dir DIR]

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MODEL_PRICING } from "@/config/evalProfiles";
import { JUDGMENT_MODEL_ID } from "@/lib/articleJudgment";
import { endPool, query } from "@/lib/db";
import { defaultEvalOutDir, parseCliArg } from "@/lib/evalCli";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { sourceWeightSql } from "@/lib/scoring";

const DEFAULT_DAYS = 7;
const DROP_BELOW = 0.1;
const IN_AT = 0.5;
const EXAMPLES = 12;
const NON_LEAD_TYPES = ["press_release", "promotional", "not_news"];

function pct(part: number, whole: number) {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function clip(text: string | null, length = 90) {
  const value = (text ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function table(headers: string[], rows: Array<Array<string | number>>) {
  if (rows.length === 0) return ["None.", ""];
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
}

export async function buildJudgeReport(days: number): Promise<string> {
  const window = `j.judged_at >= now() - make_interval(days => ${days})`;
  const weight = sourceWeightSql("s.weight", "a.canonical_url");
  const articleJoin = `
    from article_judgments j
    join articles a on a.id = j.article_id
    left join sources s on s.id = a.source_id
    where ${window} and j.status = 'ok' and ${visibleLanguagePredicate("a")}`;

  const { rows: health } = await query<{
    ok: number;
    errors: number;
    fallbacks: number;
    articles: number;
    rejections: number;
    median_ms: number | null;
    p95_ms: number | null;
    tokens: string | null;
  }>(`
    select
      count(*) filter (where status = 'ok')::int as ok,
      count(*) filter (where status = 'error')::int as errors,
      count(*) filter (where used_fallback)::int as fallbacks,
      count(*) filter (where article_id is not null)::int as articles,
      count(*) filter (where rejection_id is not null)::int as rejections,
      percentile_cont(0.5) within group (order by latency_ms)::int as median_ms,
      percentile_cont(0.95) within group (order by latency_ms)::int as p95_ms,
      sum(input_tokens)::text as tokens
    from article_judgments j
    where ${window}
  `);
  const h = health[0];
  const total = h.ok + h.errors;
  const pricing = MODEL_PRICING[JUDGMENT_MODEL_ID];
  const cost =
    pricing && h.tokens
      ? (Number(h.tokens) / 1_000_000) * pricing.inputPerMillion
      : null;

  const lines = [
    "# Judge report",
    "",
    `Shadow judgments from the last ${days} days. Nothing here affects what readers see.`,
    "",
    "## Health",
    "",
    ...table(
      [
        "Judged",
        "Failed",
        "Tie retries",
        "Median latency",
        "P95 latency",
        "Cost",
      ],
      [
        [
          h.ok,
          `${h.errors} (${pct(h.errors, total)})`,
          h.fallbacks,
          `${h.median_ms ?? "n/a"}ms`,
          `${h.p95_ms ?? "n/a"}ms`,
          cost == null ? "n/a" : `$${cost.toFixed(4)}`,
        ],
      ],
    ),
  ];

  if (h.ok === 0) {
    lines.push("No judgments in this window yet.", "");
    return lines.join("\n");
  }

  const { rows: relevance } = await query<{
    band: string;
    articles: number;
    strong: number;
  }>(`
    select
      case when j.climate_p < ${DROP_BELOW} then 'a_drop'
           when j.climate_p < ${IN_AT} then 'b_unsure'
           else 'c_in' end as band,
      count(*)::int as articles,
      count(*) filter (where ${weight} >= 8)::int as strong
    ${articleJoin}
    group by 1
    order by 1
  `);
  const bandName: Record<string, string> = {
    a_drop: `Would drop (below ${DROP_BELOW})`,
    b_unsure: `Unsure (${DROP_BELOW} to ${IN_AT})`,
    c_in: `In (${IN_AT} and above)`,
  };
  const stored = relevance.reduce((sum, row) => sum + row.articles, 0);
  lines.push(
    "## Relevance of stored articles",
    "",
    "Every stored article passed the keyword gate or came from a trusted source.",
    "",
    ...table(
      ["Judgment", "Articles", "Share", "From weight 8 to 10 sources"],
      relevance.map((row) => [
        bandName[row.band],
        row.articles,
        pct(row.articles, stored),
        row.strong,
      ]),
    ),
  );

  const { rows: lowStrong } = await query<{
    climate_p: number;
    w: number;
    source: string | null;
    title: string;
  }>(`
    select j.climate_p, ${weight} as w,
           coalesce(a.publisher_name, s.name) as source, a.title
    ${articleJoin}
      and j.climate_p < ${IN_AT} and ${weight} >= 8
    order by j.climate_p asc
    limit ${EXAMPLES}
  `);
  lines.push(
    "### Lowest-scoring articles from strong sources",
    "",
    "These clear the Top gate on source weight alone, so they are the ones a relevance check would change.",
    "",
    ...table(
      ["Score", "Weight", "Source", "Title"],
      lowStrong.map((row) => [
        row.climate_p.toFixed(2),
        row.w,
        clip(row.source, 28),
        clip(row.title),
      ]),
    ),
  );

  const { rows: gate } = await query<{
    judged: number;
    missed: number;
  }>(`
    select count(*)::int as judged,
           count(*) filter (where j.climate_p >= ${IN_AT})::int as missed
    from article_judgments j
    where ${window} and j.status = 'ok' and j.rejection_id is not null
  `);
  const { rows: gateExamples } = await query<{
    climate_p: number;
    stage: string;
    title: string;
  }>(`
    select j.climate_p, r.stage, r.title
    from article_judgments j
    join gate_rejections r on r.id = j.rejection_id
    where ${window} and j.status = 'ok' and j.climate_p >= ${IN_AT}
    order by j.climate_p desc
    limit ${EXAMPLES}
  `);
  lines.push(
    "## What the keyword gate rejected",
    "",
    `A sample of rejected items, judged: ${gate[0].judged}. The model would have kept ${gate[0].missed} (${pct(gate[0].missed, gate[0].judged)}).`,
    "",
    ...table(
      ["Score", "Stage", "Title"],
      gateExamples.map((row) => [
        row.climate_p.toFixed(2),
        row.stage,
        clip(row.title),
      ]),
    ),
  );

  const { rows: category } = await query<{
    both: number;
    same: number;
    production_none: number;
    model_fills: number;
  }>(`
    with pairs as (
      select j.primary_category as model_primary,
             (select c.slug
                from article_categories ac
                join categories c on c.id = ac.category_id
               where ac.article_id = a.id and ac.is_primary
               limit 1) as production_primary
      ${articleJoin}
        and j.climate_p >= ${IN_AT}
    )
    select
      count(*) filter (where production_primary is not null and model_primary <> 'none')::int as both,
      count(*) filter (where production_primary = model_primary)::int as same,
      count(*) filter (where production_primary is null)::int as production_none,
      count(*) filter (where production_primary is null and model_primary <> 'none')::int as model_fills
    from pairs
  `);
  const { rows: swaps } = await query<{
    production_primary: string;
    model_primary: string;
    articles: number;
  }>(`
    select production_primary, model_primary, count(*)::int as articles
    from (
      select j.primary_category as model_primary,
             (select c.slug
                from article_categories ac
                join categories c on c.id = ac.category_id
               where ac.article_id = a.id and ac.is_primary
               limit 1) as production_primary
      ${articleJoin}
        and j.climate_p >= ${IN_AT}
    ) pairs
    where production_primary is not null
      and model_primary <> 'none'
      and production_primary <> model_primary
    group by 1, 2
    order by 3 desc
    limit 8
  `);
  const c = category[0];
  lines.push(
    "## Category",
    "",
    "Articles the model judged on topic.",
    "",
    ...table(
      ["Measure", "Articles"],
      [
        ["Both chose a category", c.both],
        ["Same category", `${c.same} (${pct(c.same, c.both)})`],
        ["Production left uncategorized", c.production_none],
        ["Of those, the model chose one", c.model_fills],
      ],
    ),
    "### Most common differences",
    "",
    ...table(
      ["Production", "Model", "Articles"],
      swaps.map((row) => [
        row.production_primary,
        row.model_primary,
        row.articles,
      ]),
    ),
  );

  const { rows: language } = await query<{
    english_p: number;
    source: string | null;
    title: string;
  }>(`
    select j.english_p, coalesce(a.publisher_name, s.name) as source, a.title
    ${articleJoin}
      and j.english_p < ${IN_AT}
    order by j.english_p asc
    limit ${EXAMPLES}
  `);
  lines.push(
    "## Language",
    "",
    "Visible articles the model judged not to be in English.",
    "",
    ...table(
      ["English score", "Source", "Title"],
      language.map((row) => [
        row.english_p.toFixed(2),
        clip(row.source, 28),
        clip(row.title),
      ]),
    ),
  );

  const { rows: types } = await query<{
    article_type: string | null;
    articles: number;
    leads: number;
  }>(`
    select j.article_type, count(*)::int as articles,
           count(*) filter (
             where exists (select 1 from cluster_scores cs where cs.lead_article_id = a.id)
           )::int as leads
    ${articleJoin}
    group by 1
    order by 2 desc
  `);
  const blockedLeads = types
    .filter((row) => NON_LEAD_TYPES.includes(row.article_type ?? ""))
    .reduce((sum, row) => sum + row.leads, 0);
  lines.push(
    "## Article type",
    "",
    `${blockedLeads} current cluster leads are a press release, promotional, or not an article.`,
    "",
    ...table(
      ["Type", "Articles", "Currently leading a cluster"],
      types.map((row) => [
        row.article_type ?? "unknown",
        row.articles,
        row.leads,
      ]),
    ),
  );

  lines.push(...(await headlineCheckSection(days)));

  return lines.join("\n");
}

/** Shadow fact-check of rewritten headlines (lib/headlineCheck.ts). */
async function headlineCheckSection(days: number): Promise<string[]> {
  const { rows: present } = await query<{ name: string | null }>(
    `select to_regclass('public.headline_checks')::text as name`,
  );
  if (!present[0]?.name) return [];

  const recent = `hc.checked_at >= now() - make_interval(days => ${days}) and hc.status = 'ok'`;
  const { rows: totals } = await query<{
    has_content: boolean;
    checked: number;
    unsupported: number;
    invented: number;
  }>(`
    select hc.has_content,
           count(*)::int as checked,
           count(*) filter (where hc.supported_p < ${IN_AT})::int as unsupported,
           count(*) filter (where hc.invented_attribution_p >= ${IN_AT})::int as invented
    from headline_checks hc
    where ${recent}
    group by 1
    order by 1
  `);
  if (totals.length === 0) return [];

  const { rows: examples } = await query<{
    supported_p: number;
    invented_attribution_p: number;
    title: string;
    headline: string;
  }>(`
    select hc.supported_p, hc.invented_attribution_p, a.title, hc.headline
    from headline_checks hc
    join articles a on a.id = hc.article_id
    where ${recent}
      and hc.supported_p < ${IN_AT}
      and hc.headline = a.rewritten_title
      and exists (select 1 from cluster_scores cs where cs.lead_article_id = a.id)
    order by hc.invented_attribution_p desc, hc.supported_p asc
    limit ${EXAMPLES}
  `);

  return [
    "## Headline fact-check",
    "",
    "Rewritten headlines the model judged not supported by what the rewrite step was shown. None were blocked.",
    "",
    ...table(
      ["Article", "Checked", "Judged unsupported", "Invented attribution"],
      totals.map((row) => [
        row.has_content ? "With content" : "Title only",
        row.checked,
        `${row.unsupported} (${pct(row.unsupported, row.checked)})`,
        `${row.invented} (${pct(row.invented, row.checked)})`,
      ]),
    ),
    "### Flagged headlines now leading a cluster",
    "",
    ...table(
      ["Supported", "Invented attribution", "Original", "Rewritten"],
      examples.map((row) => [
        row.supported_p.toFixed(2),
        row.invented_attribution_p.toFixed(2),
        clip(row.title, 70),
        clip(row.headline, 110),
      ]),
    ),
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let days = DEFAULT_DAYS;
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const daysArg = parseCliArg(argv, i, "--days");
    if (daysArg) {
      const parsed = Number(daysArg.value);
      if (Number.isFinite(parsed)) days = Math.max(1, Math.floor(parsed));
      i += daysArg.skip;
      continue;
    }
    const outArg = parseCliArg(argv, i, "--out-dir");
    if (outArg) {
      outDir = outArg.value;
      i += outArg.skip;
    }
  }

  buildJudgeReport(days)
    .then(async (report) => {
      const dir = outDir || defaultEvalOutDir("judge-reports");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "report.md"), report, "utf8");
      console.log(report);
      console.log(`\n✅ Report written to ${path.join(dir, "report.md")}`);
      await endPool();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("❌ Judge report failed:", error);
      await endPool();
      process.exit(1);
    });
}
