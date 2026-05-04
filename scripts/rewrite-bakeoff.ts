import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { MODEL_PRICING } from "@/config/evalProfiles";
import { endPool } from "@/lib/db";
import {
  defaultEvalOutDir,
  median,
  parseCliArg,
  percentile,
} from "@/lib/evalCli";
import { mapLimit } from "@/lib/utils";

import {
  executeRewriteProfile,
  fetchRewriteCandidates,
  getEvalProfiles,
  prepareRewriteCandidate,
  type EvalProfile,
  type PreparedRewriteCandidate,
  type PromptVariant,
  type RewriteExecutionResult,
  type UsageSnapshot,
} from "./rewrite-eval";

const DEFAULT_SAMPLE_SIZE = 500;
const DEFAULT_WINDOW_DAYS = 21;
const DEFAULT_CONCURRENCY = 3;

type BakeoffMode = "generate" | "report";

type CliOptions = {
  mode: BakeoffMode;
  sampleSize: number;
  windowDays: number;
  concurrency: number;
  outDir?: string;
  profiles?: string[];
  reviewA?: string;
  reviewB?: string;
};

export type BakeoffResultRecord = {
  articleId: number;
  sourceName: string | null;
  canonicalUrl: string;
  publishedAt: string | null;
  clusterScore: number | null;
  contentStatus: string | null;
  originalTitle: string;
  dek: string | null;
  contentNote: string;
  profileId: string;
  provider: string;
  model: string;
  promptVariant: PromptVariant;
  success: boolean;
  retryUsed: boolean;
  finalDraft: string;
  firstDraft: string;
  retryDraft: string | null;
  firstFailureCode: string | null;
  retryFailureCode: string | null;
  finalFailureCode: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
};

type ReviewRow = {
  article_id: string;
  source_name: string;
  published_at: string;
  canonical_url: string;
  original_title: string;
  candidate_a: string;
  candidate_b: string;
  accuracy_a: string;
  accuracy_b: string;
  self_sufficiency_a: string;
  self_sufficiency_b: string;
  informative_density_a: string;
  informative_density_b: string;
  style_fit_a: string;
  style_fit_b: string;
  winner: string;
  reject_reason: string;
  notes: string;
};

type BlindKeyEntry = {
  articleId: number;
  candidateA: string;
  candidateB: string;
};

type ArmSummary = {
  count: number;
  successCount: number;
  retryUsedCount: number;
  factualSupportFailures: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalEstimatedCostUsd: number;
  costPerAcceptedUsd: number | null;
  failureCounts: Record<string, number>;
};

const REVIEW_COLUMNS = [
  "article_id",
  "source_name",
  "published_at",
  "canonical_url",
  "original_title",
  "candidate_a",
  "candidate_b",
  "accuracy_a",
  "accuracy_b",
  "self_sufficiency_a",
  "self_sufficiency_b",
  "informative_density_a",
  "informative_density_b",
  "style_fit_a",
  "style_fit_b",
  "winner",
  "reject_reason",
  "notes",
] as const;

function defaultOutDir() {
  return defaultEvalOutDir("rewrite-evals");
}

function toJsonl(items: unknown[]) {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function csvEscape(value: unknown) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function stringifyCsv(
  rows: Array<Record<string, unknown>>,
  columns: string[],
) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((row) =>
    columns.map((column) => csvEscape(row[column])).join(","),
  );
  return [header, ...body].join("\n") + "\n";
}

export function parseCsv(raw: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i++;
      }
      row.push(field);
      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const [header, ...data] = rows;
  return data.map((values) =>
    Object.fromEntries(
      header.map((column, idx) => [column, values[idx] ?? ""]),
    ),
  );
}

export function estimateCostUsd(
  modelId: string,
  usage?: UsageSnapshot,
): number | null {
  if (!usage?.inputTokens && !usage?.outputTokens) return null;
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return null;
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillion +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillion
  );
}

function numeric(value: string | null | undefined) {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deterministicBlindOrder(articleId: number) {
  return articleId % 2 === 0;
}

function groupByArticle(
  records: BakeoffResultRecord[],
): Map<number, Map<string, BakeoffResultRecord>> {
  const byArticle = new Map<number, Map<string, BakeoffResultRecord>>();
  for (const record of records) {
    if (!byArticle.has(record.articleId)) {
      byArticle.set(record.articleId, new Map());
    }
    byArticle.get(record.articleId)!.set(record.profileId, record);
  }
  return byArticle;
}

function profileColumnPrefix(profileId: string) {
  return profileId.replace(/[^a-z0-9]/gi, "_");
}

function toBakeoffRecord(
  prepared: PreparedRewriteCandidate,
  result: RewriteExecutionResult,
): BakeoffResultRecord {
  const finalGeneration = result.finalAttempt.generation;
  const usage = finalGeneration.usage;

  return {
    articleId: prepared.row.id,
    sourceName: prepared.row.source_name,
    canonicalUrl: prepared.row.canonical_url,
    publishedAt: prepared.row.published_at,
    clusterScore: prepared.row.cluster_score,
    contentStatus: prepared.row.content_status,
    originalTitle: prepared.row.title,
    dek: prepared.row.dek,
    contentNote: prepared.contentNote,
    profileId: result.profile.id,
    provider: result.profile.provider,
    model: result.profile.modelId,
    promptVariant: result.profile.promptVariant,
    success: result.success,
    retryUsed: !!result.retryAttempt,
    finalDraft: result.success ? result.finalDraft : "",
    firstDraft: result.firstAttempt.draft,
    retryDraft: result.retryAttempt?.draft ?? null,
    firstFailureCode: result.firstAttempt.validation.ok
      ? null
      : result.firstAttempt.validation.code,
    retryFailureCode: result.retryAttempt?.validation.ok
      ? null
      : (result.retryAttempt?.validation.code ?? null),
    finalFailureCode: result.finalAttempt.validation.ok
      ? null
      : result.finalAttempt.validation.code,
    latencyMs: finalGeneration.latencyMs ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    estimatedCostUsd: estimateCostUsd(result.profile.modelId, usage),
  };
}

function summarizeArm(records: BakeoffResultRecord[]): ArmSummary {
  const failureCounts: Record<string, number> = {};
  for (const record of records) {
    if (record.finalFailureCode) {
      failureCounts[record.finalFailureCode] =
        (failureCounts[record.finalFailureCode] ?? 0) + 1;
    }
  }

  const latencyValues = records
    .map((record) => record.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const factualSupportFailures = records.filter((record) =>
    ["invented_number", "hallucinated_entity", "missing_attribution"].includes(
      record.finalFailureCode ?? "",
    ),
  ).length;
  const totalEstimatedCostUsd = records.reduce(
    (sum, record) => sum + (record.estimatedCostUsd ?? 0),
    0,
  );
  const successCount = records.filter((record) => record.success).length;

  return {
    count: records.length,
    successCount,
    retryUsedCount: records.filter((record) => record.retryUsed).length,
    factualSupportFailures,
    medianLatencyMs: median(latencyValues),
    p95LatencyMs: percentile(latencyValues, 95),
    totalEstimatedCostUsd,
    costPerAcceptedUsd:
      successCount > 0 ? totalEstimatedCostUsd / successCount : null,
    failureCounts,
  };
}

function discoverProfileIds(records: BakeoffResultRecord[]): string[] {
  return [...new Set(records.map((r) => r.profileId))];
}

function comparisonColumns(profileIds: string[]): string[] {
  const shared = [
    "article_id",
    "source_name",
    "published_at",
    "canonical_url",
    "cluster_score",
    "content_status",
    "original_title",
  ];
  for (const pid of profileIds) {
    const prefix = profileColumnPrefix(pid);
    shared.push(`${prefix}_output`, `${prefix}_success`, `${prefix}_failure`);
  }
  return shared;
}

function buildComparisonRows(
  records: BakeoffResultRecord[],
  profileIds: string[],
): Array<Record<string, string>> {
  const byArticle = groupByArticle(records);

  return [...byArticle.entries()].map(([articleId, armMap]) => {
    const any = armMap.values().next().value!;
    const row: Record<string, string> = {
      article_id: String(articleId),
      source_name: any.sourceName || "",
      published_at: any.publishedAt || "",
      canonical_url: any.canonicalUrl || "",
      cluster_score: String(any.clusterScore ?? ""),
      content_status: any.contentStatus || "",
      original_title: any.originalTitle || "",
    };

    for (const pid of profileIds) {
      const r = armMap.get(pid);
      const prefix = profileColumnPrefix(pid);
      row[`${prefix}_output`] = r?.finalDraft || "";
      row[`${prefix}_success`] = String(r?.success ?? false);
      row[`${prefix}_failure`] = r?.finalFailureCode || "";
    }

    return row;
  });
}

export function buildBlindedReviewRows(
  records: BakeoffResultRecord[],
  profileA: string,
  profileB: string,
): {
  rows: ReviewRow[];
  blindKey: BlindKeyEntry[];
} {
  const byArticle = groupByArticle(records);

  const rows: ReviewRow[] = [];
  const blindKey: BlindKeyEntry[] = [];

  for (const [articleId, armMap] of byArticle.entries()) {
    const left = armMap.get(profileA);
    const right = armMap.get(profileB);
    if (!left || !right) continue;

    const aIsLeft = deterministicBlindOrder(articleId);
    const candidateA = aIsLeft ? left : right;
    const candidateB = aIsLeft ? right : left;

    rows.push({
      article_id: String(articleId),
      source_name: left.sourceName || right.sourceName || "",
      published_at: left.publishedAt || right.publishedAt || "",
      canonical_url: left.canonicalUrl || right.canonicalUrl || "",
      original_title: left.originalTitle || right.originalTitle || "",
      candidate_a: candidateA.finalDraft,
      candidate_b: candidateB.finalDraft,
      accuracy_a: "",
      accuracy_b: "",
      self_sufficiency_a: "",
      self_sufficiency_b: "",
      informative_density_a: "",
      informative_density_b: "",
      style_fit_a: "",
      style_fit_b: "",
      winner: "",
      reject_reason: "",
      notes: "",
    });

    blindKey.push({
      articleId,
      candidateA: candidateA.profileId,
      candidateB: candidateB.profileId,
    });
  }

  return { rows, blindKey };
}

function formatMoney(value: number | null) {
  return value == null ? "n/a" : `$${value.toFixed(4)}`;
}

function formatPct(value: number, total: number) {
  if (total === 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function topFailureCounts(failures: Record<string, number>) {
  return Object.entries(failures)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");
}

function buildAutoSummaryMarkdown(records: BakeoffResultRecord[]) {
  const profileIds = discoverProfileIds(records);
  const summaries = new Map(
    profileIds.map((pid) => [
      pid,
      summarizeArm(records.filter((r) => r.profileId === pid)),
    ]),
  );

  const articleCount = new Set(records.map((r) => r.articleId)).size;
  const lines = [
    "# Rewrite Eval Summary",
    "",
    `Profiles tested: ${profileIds.length}`,
    `Total articles: ${articleCount}`,
    "",
    "| Profile | Pass rate | Retry rate | Factual failures | Median latency | P95 latency | Total cost | Cost/accepted |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const pid of profileIds) {
    const s = summaries.get(pid)!;
    lines.push(
      `| ${pid} | ${formatPct(s.successCount, s.count)} | ${formatPct(s.retryUsedCount, s.count)} | ${s.factualSupportFailures} | ${s.medianLatencyMs ?? "n/a"}ms | ${s.p95LatencyMs ?? "n/a"}ms | ${formatMoney(s.totalEstimatedCostUsd)} | ${formatMoney(s.costPerAcceptedUsd)} |`,
    );
  }

  lines.push("", "## Failure Breakdown", "");
  for (const pid of profileIds) {
    lines.push(
      `- **${pid}**: ${topFailureCounts(summaries.get(pid)!.failureCounts) || "none"}`,
    );
  }

  return lines.join("\n") + "\n";
}

export function summarizeHumanReview(
  reviewRows: Array<Record<string, string>>,
  blindKey: BlindKeyEntry[],
) {
  const blindLookup = new Map(
    blindKey.map((entry) => [entry.articleId, entry]),
  );
  const wins = new Map<string, number>();
  const accuracyFails = new Map<string, number>();

  for (const entry of blindKey) {
    if (!wins.has(entry.candidateA)) wins.set(entry.candidateA, 0);
    if (!wins.has(entry.candidateB)) wins.set(entry.candidateB, 0);
    if (!accuracyFails.has(entry.candidateA))
      accuracyFails.set(entry.candidateA, 0);
    if (!accuracyFails.has(entry.candidateB))
      accuracyFails.set(entry.candidateB, 0);
  }

  let scored = 0;
  let ties = 0;

  for (const row of reviewRows) {
    const articleId = numeric(row.article_id);
    if (!articleId) continue;
    const blind = blindLookup.get(articleId);
    if (!blind) continue;

    if (row.accuracy_a.trim().toLowerCase() === "fail") {
      accuracyFails.set(
        blind.candidateA,
        (accuracyFails.get(blind.candidateA) ?? 0) + 1,
      );
    }
    if (row.accuracy_b.trim().toLowerCase() === "fail") {
      accuracyFails.set(
        blind.candidateB,
        (accuracyFails.get(blind.candidateB) ?? 0) + 1,
      );
    }

    const winner = row.winner.trim().toUpperCase();
    if (!winner) continue;

    scored++;
    if (winner === "TIE") {
      ties++;
      continue;
    }

    if (winner === "A")
      wins.set(blind.candidateA, (wins.get(blind.candidateA) ?? 0) + 1);
    if (winner === "B")
      wins.set(blind.candidateB, (wins.get(blind.candidateB) ?? 0) + 1);
  }

  return { wins, accuracyFails, scored, ties };
}

function buildFinalSummaryMarkdown(
  records: BakeoffResultRecord[],
  reviewRows: Array<Record<string, string>>,
  blindKey: BlindKeyEntry[],
) {
  const autoSummary = buildAutoSummaryMarkdown(records).trimEnd();
  const human = summarizeHumanReview(reviewRows, blindKey);
  const lines = [autoSummary, "", "## Human Review", ""];

  if (human.scored === 0) {
    lines.push("No completed human review rows detected in `review.csv`.");
    return lines.join("\n") + "\n";
  }

  lines.push(`Scored rows: ${human.scored}`, `Ties: ${human.ties}`, "");

  const profileIds = [...human.wins.keys()];
  lines.push("| Profile | Wins | Accuracy fails |", "| --- | --- | --- |");
  for (const pid of profileIds) {
    lines.push(
      `| ${pid} | ${human.wins.get(pid) ?? 0} | ${human.accuracyFails.get(pid) ?? 0} |`,
    );
  }

  return lines.join("\n") + "\n";
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mode: "generate",
    sampleSize: DEFAULT_SAMPLE_SIZE,
    windowDays: DEFAULT_WINDOW_DAYS,
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let i = 0; i < argv.length; i++) {
    let match: { value: string; skip: number } | null;

    match = parseCliArg(argv, i, "--mode");
    if (match && (match.value === "generate" || match.value === "report")) {
      opts.mode = match.value;
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--sample-size");
    if (match) {
      const parsed = Number(match.value);
      if (Number.isFinite(parsed))
        opts.sampleSize = Math.max(1, Math.floor(parsed));
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--window-days");
    if (match) {
      const parsed = Number(match.value);
      if (Number.isFinite(parsed))
        opts.windowDays = Math.max(1, Math.floor(parsed));
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--concurrency");
    if (match) {
      const parsed = Number(match.value);
      if (Number.isFinite(parsed))
        opts.concurrency = Math.max(1, Math.floor(parsed));
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--out-dir");
    if (match) {
      opts.outDir = match.value;
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--profiles");
    if (match) {
      opts.profiles = match.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--review-a");
    if (match) {
      opts.reviewA = match.value;
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--review-b");
    if (match) {
      opts.reviewB = match.value;
      i += match.skip;
      continue;
    }
  }

  return opts;
}

function resolveProfiles(opts: CliOptions): EvalProfile[] {
  const all = getEvalProfiles();
  if (!opts.profiles || opts.profiles.length === 0) return all;
  const filtered = all.filter((p) => opts.profiles!.includes(p.id));
  if (filtered.length === 0) {
    const available = all.map((p) => p.id).join(", ");
    throw new Error(`No matching profiles. Available: ${available}`);
  }
  return filtered;
}

function resolveReviewPair(
  opts: CliOptions,
  profileIds: string[],
): [string, string] {
  if (opts.reviewA && opts.reviewB) return [opts.reviewA, opts.reviewB];
  if (profileIds.length >= 2) return [profileIds[0], profileIds[1]];
  throw new Error(
    "Blind review requires at least 2 profiles (or use --review-a / --review-b)",
  );
}

async function loadEvalSample(
  sampleSize: number,
  windowDays: number,
): Promise<PreparedRewriteCandidate[]> {
  const rawRows = await fetchRewriteCandidates({
    limit: Math.max(sampleSize * 4, sampleSize + 100),
    pendingOnly: false,
    recentDays: windowDays,
  });

  const prepared: PreparedRewriteCandidate[] = [];
  for (const row of rawRows) {
    const candidate = prepareRewriteCandidate(row);
    if (!candidate.isClimate) continue;
    prepared.push(candidate);
    if (prepared.length >= sampleSize) break;
  }

  return prepared;
}

async function writeArtifacts(
  outDir: string,
  sample: PreparedRewriteCandidate[],
  records: BakeoffResultRecord[],
  reviewPair: [string, string],
) {
  await mkdir(outDir, { recursive: true });

  const profileIds = discoverProfileIds(records);

  await writeFile(
    path.join(outDir, "sample.jsonl"),
    toJsonl(
      sample.map((candidate) => ({
        articleId: candidate.row.id,
        sourceName: candidate.row.source_name,
        canonicalUrl: candidate.row.canonical_url,
        publishedAt: candidate.row.published_at,
        clusterScore: candidate.row.cluster_score,
        contentStatus: candidate.row.content_status,
        title: candidate.row.title,
        dek: candidate.row.dek,
        contentNote: candidate.contentNote,
      })),
    ),
    "utf8",
  );

  await writeFile(path.join(outDir, "outputs.jsonl"), toJsonl(records), "utf8");

  const columns = comparisonColumns(profileIds);
  const comparisonRows = buildComparisonRows(records, profileIds);
  await writeFile(
    path.join(outDir, "comparison.csv"),
    stringifyCsv(comparisonRows, columns),
    "utf8",
  );

  const { rows: reviewRows, blindKey } = buildBlindedReviewRows(
    records,
    reviewPair[0],
    reviewPair[1],
  );
  await writeFile(
    path.join(outDir, "review.csv"),
    stringifyCsv(reviewRows, [...REVIEW_COLUMNS]),
    "utf8",
  );

  await writeFile(
    path.join(outDir, "blind-key.json"),
    JSON.stringify(blindKey, null, 2) + "\n",
    "utf8",
  );

  await writeFile(
    path.join(outDir, "summary.auto.md"),
    buildAutoSummaryMarkdown(records),
    "utf8",
  );
}

async function generateEval(opts: CliOptions) {
  const outDir = opts.outDir || defaultOutDir();
  const profiles = resolveProfiles(opts);
  const sample = await loadEvalSample(opts.sampleSize, opts.windowDays);
  const reviewPair = resolveReviewPair(
    opts,
    profiles.map((p) => p.id),
  );

  console.log(
    `🧪 Running rewrite eval on ${sample.length} articles across ${profiles.length} profiles...`,
  );

  const nested = await mapLimit(sample, opts.concurrency, async (candidate) => {
    const results = await Promise.all(
      profiles.map((profile) => executeRewriteProfile(candidate, profile)),
    );
    return results.map((result) => toBakeoffRecord(candidate, result));
  });

  const records = nested.flat();
  await writeArtifacts(outDir, sample, records, reviewPair);

  console.log(`✅ Eval artifacts written to ${outDir}`);
}

async function reportEval(opts: CliOptions) {
  if (!opts.outDir) {
    throw new Error(
      "report mode requires --out-dir pointing at an existing eval directory",
    );
  }
  const outDir = opts.outDir;
  const outputsRaw = await readFile(path.join(outDir, "outputs.jsonl"), "utf8");
  const blindKeyRaw = await readFile(
    path.join(outDir, "blind-key.json"),
    "utf8",
  );
  const reviewRaw = await readFile(path.join(outDir, "review.csv"), "utf8");

  const records = parseJsonl<BakeoffResultRecord>(outputsRaw);
  const blindKey = JSON.parse(blindKeyRaw) as BlindKeyEntry[];
  const reviewRows = parseCsv(reviewRaw);

  await writeFile(
    path.join(outDir, "summary.final.md"),
    buildFinalSummaryMarkdown(records, reviewRows, blindKey),
    "utf8",
  );

  console.log(
    `✅ Final report written to ${path.join(outDir, "summary.final.md")}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseCliArgs(process.argv.slice(2));

  (opts.mode === "report" ? reportEval(opts) : generateEval(opts))
    .then(async () => {
      await endPool();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("❌ Eval failed:", error);
      await endPool();
      process.exit(1);
    });
}
