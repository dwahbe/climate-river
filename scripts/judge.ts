// scripts/judge.ts
// Judge stage, shadow mode: asks lib/articleJudgment.ts about recent articles
// and about the sampled items the keyword gate rejected, and stores the
// answers in article_judgments. Nothing reads them for display yet; compare
// them with production using `bun run judge:report`.
//
// CLI: bun scripts/judge.ts [--dry-run] [--limit N] [--days N]

import { endPool, query } from "@/lib/db";
import {
  JUDGMENT_MODEL_ID,
  RUBRIC_VERSION,
  buildJudgmentInput,
  judgeArticle,
  type JudgmentResult,
} from "@/lib/articleJudgment";
import { median, parseCliArg } from "@/lib/evalCli";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { mapLimit } from "@/lib/utils";

import { LlmCircuitBreaker } from "./rewrite";

const DEFAULT_LIMIT = 60;
const DEFAULT_DAYS = 3;
const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
/** Share of each run's budget spent on sampled gate rejections. */
const REJECTION_SHARE = 0.25;
const CONTENT_MAX_CHARS = 2000;

type Subject = {
  kind: "article" | "rejection";
  id: number;
  title: string;
  dek: string | null;
  contentText: string | null;
};

export type JudgeOptions = {
  limit?: number;
  days?: number;
  concurrency?: number;
  deadlineMs?: number;
  deadlineAt?: number;
  dryRun?: boolean;
  closePool?: boolean;
};

export type JudgeRunResult =
  | {
      ok: true;
      dryRun: boolean;
      selected: number;
      judged: number;
      failed: number;
      skipped: number;
      articles: number;
      rejections: number;
      fallbacks: number;
      medianLatencyMs: number | null;
      inputTokens: number;
      breakerTripped: boolean;
      /** True when the deadline or the breaker stopped the run early. */
      partial: boolean;
    }
  | { ok: false; error: string };

async function tablesExist(): Promise<boolean> {
  const { rows } = await query<{ judgments: string | null }>(
    `select to_regclass('public.article_judgments')::text as judgments`,
  );
  return rows[0]?.judgments != null;
}

type SubjectRow = {
  id: string | number;
  title: string;
  dek: string | null;
  content_text: string | null;
};

function toSubject(kind: Subject["kind"], row: SubjectRow): Subject {
  return {
    kind,
    id: Number(row.id),
    title: row.title,
    dek: row.dek,
    contentText: row.content_text,
  };
}

/**
 * Articles with no judgment, a failed one still under the attempt cap, one
 * made before the content arrived, or one made under an older rubric.
 */
async function selectArticles(
  days: number,
  limit: number,
  withJudgments: boolean,
): Promise<Subject[]> {
  const pending = withJudgments
    ? `and (
         j.id is null
         or (j.status = 'error' and j.attempts < ${MAX_ATTEMPTS})
         or (j.status = 'ok' and j.rubric_version <> $3)
         or (j.status = 'ok' and a.content_status = 'success'
             and a.content_fetched_at > j.judged_at)
       )`
    : "";
  const { rows } = await query<SubjectRow>(
    `
      select a.id, a.title, a.dek,
             left(a.content_text, ${CONTENT_MAX_CHARS}) as content_text
      from articles a
      ${withJudgments ? "left join article_judgments j on j.article_id = a.id" : ""}
      where a.fetched_at >= now() - make_interval(days => $1)
        and ${visibleLanguagePredicate("a")}
        ${pending}
      order by a.fetched_at desc
      limit $2
    `,
    withJudgments ? [days, limit, RUBRIC_VERSION] : [days, limit],
  );
  return rows.map((row) => toSubject("article", row));
}

async function selectRejections(
  days: number,
  limit: number,
): Promise<Subject[]> {
  if (limit <= 0) return [];
  const { rows } = await query<SubjectRow>(
    `
      select r.id, r.title, r.dek, null::text as content_text
      from gate_rejections r
      left join article_judgments j on j.rejection_id = r.id
      where r.rejected_at >= now() - make_interval(days => $1)
        and (j.id is null or (j.status = 'error' and j.attempts < ${MAX_ATTEMPTS}))
      order by r.rejected_at desc
      limit $2
    `,
    [days, limit],
  );
  return rows.map((row) => toSubject("rejection", row));
}

async function storeJudgment(
  subject: Subject,
  outcome: { result: JudgmentResult } | { error: string; latencyMs: number },
): Promise<void> {
  const column = subject.kind === "article" ? "article_id" : "rejection_id";
  const judgment = "result" in outcome ? outcome.result.judgment : null;

  await query(
    `
      insert into article_judgments (
        ${column}, model, rubric_version, status, error_msg,
        climate_p, english_p, primary_category, primary_p, category_p,
        article_type, article_type_p, used_fallback, input_tokens, latency_ms
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
              $11, $12::jsonb, $13, $14, $15)
      on conflict (${column}) where ${column} is not null do update set
        model = excluded.model,
        rubric_version = excluded.rubric_version,
        status = excluded.status,
        error_msg = excluded.error_msg,
        attempts = article_judgments.attempts + 1,
        climate_p = excluded.climate_p,
        english_p = excluded.english_p,
        primary_category = excluded.primary_category,
        primary_p = excluded.primary_p,
        category_p = excluded.category_p,
        article_type = excluded.article_type,
        article_type_p = excluded.article_type_p,
        used_fallback = excluded.used_fallback,
        input_tokens = excluded.input_tokens,
        latency_ms = excluded.latency_ms,
        judged_at = now()
    `,
    [
      subject.id,
      JUDGMENT_MODEL_ID,
      RUBRIC_VERSION,
      judgment ? "ok" : "error",
      "error" in outcome ? outcome.error.slice(0, 300) : null,
      judgment?.climateP ?? null,
      judgment?.englishP ?? null,
      judgment?.primary ?? null,
      judgment?.primaryP ? JSON.stringify(judgment.primaryP) : null,
      judgment ? JSON.stringify(judgment.categoryP) : null,
      judgment?.articleType ?? null,
      judgment?.articleTypeP ? JSON.stringify(judgment.articleTypeP) : null,
      "result" in outcome ? outcome.result.usedFallback : false,
      "result" in outcome ? outcome.result.inputTokens : null,
      "result" in outcome ? outcome.result.latencyMs : outcome.latencyMs,
    ],
  );
}

function describe(subject: Subject, result: JudgmentResult): string {
  const j = result.judgment;
  return `  ${subject.kind === "rejection" ? "✗gate" : "     "} climate=${j.climateP.toFixed(2)} english=${j.englishP.toFixed(2)} ${j.primary.padEnd(10)} ${(j.articleType ?? "?").padEnd(13)} ${subject.title.slice(0, 70)}`;
}

export async function run(opts: JudgeOptions = {}): Promise<JudgeRunResult> {
  const started = Date.now();
  const dryRun = opts.dryRun ?? false;
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const days = Math.max(1, opts.days ?? DEFAULT_DAYS);
  const deadlineAt =
    opts.deadlineAt ?? (opts.deadlineMs ? started + opts.deadlineMs : Infinity);

  console.log(
    `⚖️  Judging up to ${limit} items from the last ${days}d${dryRun ? " (dry run, no writes)" : ""}...`,
  );

  try {
    const hasTables = await tablesExist();
    if (!hasTables && !dryRun) {
      const error = "article_judgments is missing; run `bun run schema` first";
      console.warn(`⚠️  ${error}`);
      if (opts.closePool) await endPool();
      return { ok: false, error };
    }

    const rejectionLimit = hasTables ? Math.floor(limit * REJECTION_SHARE) : 0;
    const rejections = await selectRejections(days, rejectionLimit);
    const articles = await selectArticles(
      days,
      limit - rejections.length,
      hasTables,
    );
    const subjects = [...articles, ...rejections];

    const breaker = new LlmCircuitBreaker();
    const latencies: number[] = [];
    let judged = 0;
    let failed = 0;
    let skipped = 0;
    let fallbacks = 0;
    let inputTokens = 0;

    await mapLimit(
      subjects,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      async (subject) => {
        // Budget guard: never start a call past the deadline, or into a
        // provider that has just failed several times in a row.
        if (Date.now() > deadlineAt || breaker.tripped) {
          skipped += 1;
          return;
        }

        const callStarted = Date.now();
        try {
          const result = await judgeArticle(
            buildJudgmentInput(subject.title, subject.dek, subject.contentText),
          );
          breaker.recordSuccess();
          judged += 1;
          latencies.push(result.latencyMs);
          inputTokens += result.inputTokens ?? 0;
          if (result.usedFallback) fallbacks += 1;
          if (dryRun) console.log(describe(subject, result));
          else await storeJudgment(subject, { result });
        } catch (error) {
          breaker.recordError();
          failed += 1;
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `  ⚠️  Judgment failed for ${subject.kind} ${subject.id}: ${message.slice(0, 120)}`,
          );
          if (!dryRun) {
            try {
              await storeJudgment(subject, {
                error: message,
                latencyMs: Date.now() - callStarted,
              });
            } catch (storeError) {
              console.warn("  ⚠️  Could not record the failure:", storeError);
            }
          }
        }
      },
    );

    if (breaker.tripped) {
      console.warn(
        `🛑 Circuit breaker tripped after consecutive failures; skipped ${skipped} items`,
      );
    }

    const result: JudgeRunResult = {
      ok: true,
      dryRun,
      selected: subjects.length,
      judged,
      failed,
      skipped,
      articles: articles.length,
      rejections: rejections.length,
      fallbacks,
      medianLatencyMs: median(latencies),
      inputTokens,
      breakerTripped: breaker.tripped,
      partial: skipped > 0,
    };
    console.log(
      `✅ Judge complete: ${judged} judged, ${failed} failed, ${skipped} skipped (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );

    if (opts.closePool) await endPool();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Judge stage failed:", message);
    if (opts.closePool) await endPool();
    return { ok: false, error: message };
  }
}

function parseCliArgs(argv: string[]): JudgeOptions {
  const opts: JudgeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run" || argv[i] === "-n") {
      opts.dryRun = true;
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
    .then((result) => {
      console.log("\n📊 Final results:", result);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error("❌ Fatal error:", error);
      process.exit(1);
    });
}
