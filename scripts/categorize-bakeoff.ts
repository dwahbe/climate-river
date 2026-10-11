// scripts/categorize-bakeoff.ts
// Categorization bakeoff: current production hybrid vs evaluation/chat models.
//   generate: sample recent articles, run every arm, write a blind review sheet
//   report:   score each arm against the labels filled into review.csv
// Read-only against the database. Artifacts land in tmp/categorize-evals/.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ARTICLE_TYPES,
  DEFAULT_CATEGORIZE_EVAL_ARMS,
  DEFAULT_CATEGORY_THRESHOLD,
  DEFAULT_CLIMATE_THRESHOLD,
  EXTRA_CATEGORIZE_EVAL_ARMS,
  type ArticleType,
  type CategorizeEvalArm,
} from "@/config/categorizeEvalProfiles";
import { endPool } from "@/lib/db";
import {
  defaultEvalOutDir,
  median,
  parseCliArg,
  percentile,
} from "@/lib/evalCli";
import { CATEGORIES, type CategorySlug } from "@/lib/tagger";
import { mapLimit } from "@/lib/utils";

import {
  ARTICLE_TYPE_KEYS,
  CATEGORY_SLUGS,
  IMPACT_KINDS,
  assertProductionArmIsReadOnly,
  decide,
  executeCategorizeArm,
  fetchCategorizeEvalRowsByIds,
  fetchCategorizeEvalSample,
  prepareCategorizeCandidate,
  type ArmDecision,
  type ArmPrediction,
  type CategorizeEvalCandidate,
  type ImpactKind,
  type Thresholds,
} from "./categorize-eval";
import { parseCsv, stringifyCsv } from "./rewrite-bakeoff";

const DEFAULT_SAMPLE_SIZE = 300;
const DEFAULT_WINDOW_DAYS = 21;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_SEED = "categorize-eval";
const DEFAULT_LABELS_FILE = "review.csv";
const REVIEW_SUMMARY_MAX_CHARS = 600;
const SWEEP_THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

type BakeoffMode = "generate" | "report";

type CliOptions = {
  mode: BakeoffMode;
  sampleSize: number;
  windowDays: number;
  concurrency: number;
  seed: string;
  thresholds: Thresholds;
  outDir?: string;
  arms?: string[];
  /** generate: reuse the articles of this earlier run directory. */
  sampleFrom?: string;
  /** report: label file inside the run directory. */
  labelsFile: string;
};

export type SampleRecord = {
  articleId: number;
  sourceName: string | null;
  canonicalUrl: string;
  publishedAt: string | null;
  title: string;
  summary: string | null;
  trusted: boolean;
  storedPrimary: string | null;
  categorizeStatus: string | null;
};

export type GoldLabel = {
  articleId: number;
  climate: boolean;
  /** False when label_primary was left blank on a climate article. */
  primaryLabelled: boolean;
  primary: CategorySlug | null;
  /** Primary plus any secondary categories. */
  categories: CategorySlug[];
  articleType: ArticleType | null;
  storyKind: StoryKind | null;
};

/** Impact kinds that are in, plus the two weather outcomes that are out. */
export const STORY_KINDS = [...IMPACT_KINDS, "routine", "side_story"] as const;
export type StoryKind = ImpactKind | "routine" | "side_story";

export type ArmScore = {
  armId: string;
  labelled: number;
  failed: number;
  relevance: {
    tp: number;
    fp: number;
    tn: number;
    fn: number;
    accuracy: number | null;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    brier: number | null;
  };
  primary: {
    total: number;
    exact: number;
    lenient: number;
    exactAccuracy: number | null;
    lenientAccuracy: number | null;
  };
  multiLabel: {
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  articleType: {
    total: number;
    correct: number;
    accuracy: number | null;
  } | null;
};

const REVIEW_COLUMNS = [
  "article_id",
  "arms_disagree",
  "source_name",
  "published_at",
  "canonical_url",
  "title",
  "summary",
  "label_climate",
  "label_primary",
  "label_secondary",
  "label_article_type",
  "label_story_kind",
  "notes",
] as const;

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

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function f1Score(precision: number | null, recall: number | null) {
  if (precision == null || recall == null) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function formatPct(value: number | null) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatMoney(value: number | null, digits = 4) {
  return value == null ? "n/a" : `$${value.toFixed(digits)}`;
}

function toSampleRecord(candidate: CategorizeEvalCandidate): SampleRecord {
  return {
    articleId: candidate.row.id,
    sourceName: candidate.row.source_name,
    canonicalUrl: candidate.row.canonical_url,
    publishedAt: candidate.row.published_at
      ? new Date(candidate.row.published_at).toISOString()
      : null,
    title: candidate.title,
    summary: candidate.summary,
    trusted: candidate.trusted,
    storedPrimary: candidate.row.stored_primary,
    categorizeStatus: candidate.row.categorize_status,
  };
}

function discoverArmIds(predictions: ArmPrediction[]): string[] {
  return [...new Set(predictions.map((p) => p.armId))];
}

function groupByArticle(predictions: ArmPrediction[]) {
  const grouped = new Map<number, Map<string, ArmPrediction>>();
  for (const prediction of predictions) {
    const byArm = grouped.get(prediction.articleId) ?? new Map();
    byArm.set(prediction.armId, prediction);
    grouped.set(prediction.articleId, byArm);
  }
  return grouped;
}

/** True when successful arms differ on relevance or on primary category. */
export function armsDisagree(
  predictions: ArmPrediction[],
  thresholds: Thresholds,
): boolean {
  const decisions = predictions
    .map((prediction) => decide(prediction, thresholds))
    .filter((decision): decision is ArmDecision => decision !== null);
  if (decisions.length < 2) return false;

  const [first, ...rest] = decisions;
  return rest.some(
    (decision) =>
      decision.climate !== first.climate || decision.primary !== first.primary,
  );
}

/**
 * Blind review sheet: no predictions, disagreement rows first. Each group
 * keeps the sample's random order, so labelling a prefix is an unbiased subset.
 */
export function buildReviewRows(
  sample: SampleRecord[],
  predictions: ArmPrediction[],
  thresholds: Thresholds,
): Array<Record<string, unknown>> {
  const grouped = groupByArticle(predictions);

  return sample
    .map((record) => ({
      record,
      disagree: armsDisagree(
        [...(grouped.get(record.articleId)?.values() ?? [])],
        thresholds,
      ),
    }))
    .sort((a, b) => Number(b.disagree) - Number(a.disagree))
    .map(({ record, disagree }) => ({
      article_id: record.articleId,
      arms_disagree: disagree ? "yes" : "no",
      source_name: record.sourceName ?? "",
      published_at: record.publishedAt ?? "",
      canonical_url: record.canonicalUrl,
      title: record.title,
      summary: (record.summary ?? "").slice(0, REVIEW_SUMMARY_MAX_CHARS),
      label_climate: "",
      label_primary: "",
      label_secondary: "",
      label_article_type: "",
      label_story_kind: "",
      notes: "",
    }));
}

function armColumnPrefix(armId: string) {
  return armId.replace(/[^a-zA-Z0-9]+/g, "_");
}

function formatProbabilities(prediction: ArmPrediction) {
  return CATEGORY_SLUGS.filter(
    (slug) => prediction.categoryProbabilities[slug] != null,
  )
    .map(
      (slug) => `${slug}:${prediction.categoryProbabilities[slug]!.toFixed(2)}`,
    )
    .join(" ");
}

function comparisonColumns(armIds: string[]): string[] {
  const columns = [
    "article_id",
    "arms_disagree",
    "source_name",
    "title",
    "stored_primary",
  ];
  for (const armId of armIds) {
    const prefix = armColumnPrefix(armId);
    columns.push(
      `${prefix}_climate_p`,
      `${prefix}_primary`,
      `${prefix}_categories`,
      `${prefix}_article_type`,
      `${prefix}_impact_kind`,
      `${prefix}_latency_ms`,
      `${prefix}_error`,
    );
  }
  return columns;
}

function buildComparisonRows(
  sample: SampleRecord[],
  predictions: ArmPrediction[],
  armIds: string[],
  thresholds: Thresholds,
): Array<Record<string, unknown>> {
  const grouped = groupByArticle(predictions);

  return sample.map((record) => {
    const byArm = grouped.get(record.articleId) ?? new Map();
    const row: Record<string, unknown> = {
      article_id: record.articleId,
      arms_disagree: armsDisagree([...byArm.values()], thresholds)
        ? "yes"
        : "no",
      source_name: record.sourceName ?? "",
      title: record.title,
      stored_primary: record.storedPrimary ?? "",
    };

    for (const armId of armIds) {
      const prefix = armColumnPrefix(armId);
      const prediction = byArm.get(armId);
      const decision = prediction ? decide(prediction, thresholds) : null;
      row[`${prefix}_climate_p`] =
        prediction?.climateProbability?.toFixed(2) ?? "";
      row[`${prefix}_primary`] = decision?.primary ?? "";
      row[`${prefix}_categories`] = prediction
        ? formatProbabilities(prediction)
        : "";
      row[`${prefix}_article_type`] = prediction?.articleType ?? "";
      row[`${prefix}_impact_kind`] = prediction?.impactKind ?? "";
      row[`${prefix}_latency_ms`] = prediction?.latencyMs ?? "";
      row[`${prefix}_error`] = prediction?.error ?? "";
    }

    return row;
  });
}

function speedAndCostLines(predictions: ArmPrediction[], armIds: string[]) {
  const lines = [
    "| Arm | Calls | Failed | Median latency | P95 latency | Total cost | Cost per 1,000 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const armId of armIds) {
    const armPredictions = predictions.filter((p) => p.armId === armId);
    const succeeded = armPredictions.filter((p) => p.ok);
    const latencies = succeeded
      .map((p) => p.latencyMs)
      .filter((v): v is number => v != null);
    const costs = succeeded
      .map((p) => p.estimatedCostUsd)
      .filter((v): v is number => v != null);
    const totalCost =
      costs.length > 0 ? costs.reduce((sum, v) => sum + v, 0) : null;
    const perThousand =
      totalCost == null ? null : (totalCost / costs.length) * 1000;

    lines.push(
      `| ${armId} | ${armPredictions.length} | ${armPredictions.length - succeeded.length} | ${median(latencies) ?? "n/a"}ms | ${percentile(latencies, 95) ?? "n/a"}ms | ${formatMoney(totalCost)} | ${formatMoney(perThousand, 3)} |`,
    );
  }

  return lines;
}

function topErrors(predictions: ArmPrediction[]) {
  const counts = new Map<string, number>();
  for (const prediction of predictions) {
    if (!prediction.error) continue;
    const key = prediction.error.slice(0, 80);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([message, count]) => `${message} (${count})`)
    .join("; ");
}

export function buildAutoSummaryMarkdown(
  sample: SampleRecord[],
  predictions: ArmPrediction[],
  thresholds: Thresholds,
) {
  const armIds = discoverArmIds(predictions);
  const grouped = groupByArticle(predictions);
  const disagreements = sample.filter((record) =>
    armsDisagree(
      [...(grouped.get(record.articleId)?.values() ?? [])],
      thresholds,
    ),
  ).length;

  const lines = [
    "# Categorization Eval Summary",
    "",
    "No labels yet: this shows how the arms behave and where they differ, not which is right.",
    "",
    `Articles: ${sample.length}`,
    `Arms: ${armIds.join(", ")}`,
    `Thresholds: climate ${thresholds.climate}, category ${thresholds.category} (production uses its own rules)`,
    `Rows where arms disagree: ${disagreements} (${formatPct(ratio(disagreements, sample.length))})`,
    "",
    "## Decisions",
    "",
    `| Arm | Climate | Climate, no category | ${CATEGORY_SLUGS.join(" | ")} |`,
    `| --- | --- | --- | ${CATEGORY_SLUGS.map(() => "---").join(" | ")} |`,
  ];

  for (const armId of armIds) {
    const decisions = predictions
      .filter((p) => p.armId === armId)
      .map((p) => decide(p, thresholds))
      .filter((d): d is ArmDecision => d !== null);
    const climate = decisions.filter((d) => d.climate);
    const primaryCounts = CATEGORY_SLUGS.map(
      (slug) => climate.filter((d) => d.primary === slug).length,
    );
    lines.push(
      `| ${armId} | ${formatPct(ratio(climate.length, decisions.length))} | ${climate.filter((d) => d.primary === null).length} | ${primaryCounts.join(" | ")} |`,
    );
  }

  lines.push(
    "",
    "Category columns count articles by primary category.",
    "",
    "## Pairwise agreement",
    "",
    "| Arms | Same relevance | Same primary |",
    "| --- | --- | --- |",
  );

  for (let i = 0; i < armIds.length; i++) {
    for (let j = i + 1; j < armIds.length; j++) {
      let both = 0;
      let sameClimate = 0;
      let samePrimary = 0;
      for (const byArm of grouped.values()) {
        const a = byArm.get(armIds[i]);
        const b = byArm.get(armIds[j]);
        const da = a ? decide(a, thresholds) : null;
        const db = b ? decide(b, thresholds) : null;
        if (!da || !db) continue;
        both++;
        if (da.climate === db.climate) sameClimate++;
        if (da.primary === db.primary) samePrimary++;
      }
      lines.push(
        `| ${armIds[i]} vs ${armIds[j]} | ${formatPct(ratio(sameClimate, both))} | ${formatPct(ratio(samePrimary, both))} |`,
      );
    }
  }

  lines.push(
    "",
    "## Speed and cost",
    "",
    ...speedAndCostLines(predictions, armIds),
  );

  const errorLines = armIds
    .map((armId) => ({
      armId,
      errors: topErrors(predictions.filter((p) => p.armId === armId)),
    }))
    .filter((entry) => entry.errors);
  if (errorLines.length > 0) {
    lines.push("", "## Errors", "");
    for (const entry of errorLines) {
      lines.push(`- **${entry.armId}**: ${entry.errors}`);
    }
  }

  return lines.join("\n") + "\n";
}

function buildReviewGuideMarkdown(outDir: string) {
  const relativeOutDir = path.relative(process.cwd(), outDir) || ".";
  return [
    "# Labelling guide",
    "",
    "Fill the `label_*` columns in `review.csv`. The sheet hides what each arm predicted.",
    "Rows where the arms disagree come first. Those rows separate the arms, so label them first; label some agreeing rows too if you want absolute accuracy.",
    "Rows with a blank `label_climate` are skipped by the report.",
    "",
    "## Columns",
    "",
    "- `label_climate`: `y` or `n`. " +
      "Is the article substantively about climate?",
    "- `label_primary`: one category slug, or `none` if it is climate but fits no category. Leave blank when `label_climate` is `n`.",
    "- `label_secondary`: optional extra category slugs, separated by commas.",
    "- `label_article_type`: optional. One of the article types below.",
    `- \`label_story_kind\`: optional, for impact and weather stories. One of ${STORY_KINDS.map((kind) => `\`${kind}\``).join(", ")}. See docs/categorization.md.`,
    "- `notes`: free text, ignored by the report.",
    "",
    "## Categories",
    "",
    ...CATEGORIES.map((c) => `- \`${c.slug}\` (${c.name}): ${c.description}`),
    "",
    "## Article types",
    "",
    ...ARTICLE_TYPE_KEYS.map((key) => `- \`${key}\`: ${ARTICLE_TYPES[key]}`),
    "",
    "## Then run",
    "",
    "```bash",
    `bun run categorize:eval:report --out-dir ${relativeOutDir}`,
    "```",
    "",
  ].join("\n");
}

const YES_VALUES = new Set(["y", "yes", "true", "1"]);
const NO_VALUES = new Set(["n", "no", "false", "0"]);

const CATEGORY_LABEL_LOOKUP = new Map<string, CategorySlug>(
  CATEGORIES.flatMap((c) => [
    [c.slug.toLowerCase(), c.slug] as [string, CategorySlug],
    [c.name.toLowerCase(), c.slug] as [string, CategorySlug],
  ]),
);

/** Parse the filled review sheet. Unlabelled rows are skipped, bad values reported. */
export function parseGoldLabels(reviewRows: Array<Record<string, string>>): {
  labels: GoldLabel[];
  warnings: string[];
} {
  const labels: GoldLabel[] = [];
  const warnings: string[] = [];

  for (const row of reviewRows) {
    const articleId = Number(row.article_id);
    const climateRaw = (row.label_climate ?? "").trim().toLowerCase();
    if (!climateRaw) continue;
    if (!Number.isFinite(articleId)) {
      warnings.push(`Row with article_id "${row.article_id}" skipped`);
      continue;
    }
    if (!YES_VALUES.has(climateRaw) && !NO_VALUES.has(climateRaw)) {
      warnings.push(
        `Article ${articleId}: label_climate "${row.label_climate}" is not y or n; row skipped`,
      );
      continue;
    }
    const climate = YES_VALUES.has(climateRaw);

    let primary: CategorySlug | null = null;
    let primaryLabelled = !climate;
    const categories: CategorySlug[] = [];

    if (climate) {
      const primaryRaw = (row.label_primary ?? "").trim().toLowerCase();
      if (primaryRaw === "none") {
        primaryLabelled = true;
      } else if (primaryRaw) {
        const slug = CATEGORY_LABEL_LOOKUP.get(primaryRaw);
        if (slug) {
          primary = slug;
          primaryLabelled = true;
          categories.push(slug);
        } else {
          warnings.push(
            `Article ${articleId}: label_primary "${row.label_primary}" is not a category; category scoring skips this row`,
          );
        }
      }

      for (const part of (row.label_secondary ?? "").split(/[,;|]/)) {
        const secondaryRaw = part.trim().toLowerCase();
        if (!secondaryRaw) continue;
        const slug = CATEGORY_LABEL_LOOKUP.get(secondaryRaw);
        if (!slug) {
          warnings.push(
            `Article ${articleId}: label_secondary "${part.trim()}" is not a category; ignored`,
          );
        } else if (!categories.includes(slug)) {
          categories.push(slug);
        }
      }
    }

    const typeRaw = (row.label_article_type ?? "").trim().toLowerCase();
    let articleType: ArticleType | null = null;
    if (typeRaw) {
      const match = ARTICLE_TYPE_KEYS.find((key) => key === typeRaw);
      if (match) {
        articleType = match;
      } else {
        warnings.push(
          `Article ${articleId}: label_article_type "${row.label_article_type}" is not an article type; ignored`,
        );
      }
    }

    const kindRaw = (row.label_story_kind ?? "").trim().toLowerCase();
    let storyKind: StoryKind | null = null;
    if (kindRaw) {
      const match = STORY_KINDS.find((kind) => kind === kindRaw);
      if (match) {
        storyKind = match;
      } else {
        warnings.push(
          `Article ${articleId}: label_story_kind "${row.label_story_kind}" is not a story kind; ignored`,
        );
      }
    }

    labels.push({
      articleId,
      climate,
      primaryLabelled,
      primary,
      categories,
      articleType,
      storyKind,
    });
  }

  return { labels, warnings };
}

/**
 * Score one arm against the labels. A failed call counts as a wrong answer in
 * every accuracy figure; precision and recall use successful calls only.
 */
export function scoreArm(
  armId: string,
  predictions: ArmPrediction[],
  labels: GoldLabel[],
  thresholds: Thresholds,
): ArmScore {
  const byArticle = new Map(
    predictions.filter((p) => p.armId === armId).map((p) => [p.articleId, p]),
  );

  let failed = 0;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let brierSum = 0;
  let brierCount = 0;
  let primaryTotal = 0;
  let primaryExact = 0;
  let primaryLenient = 0;
  let labelTp = 0;
  let labelFp = 0;
  let labelFn = 0;
  let typeTotal = 0;
  let typeCorrect = 0;
  let producesArticleType = false;

  for (const label of labels) {
    const prediction = byArticle.get(label.articleId);
    const decision = prediction ? decide(prediction, thresholds) : null;
    if (!decision) failed++;
    if (prediction?.articleType) producesArticleType = true;

    if (decision) {
      if (label.climate && decision.climate) tp++;
      else if (!label.climate && decision.climate) fp++;
      else if (!label.climate && !decision.climate) tn++;
      else fn++;

      const probability = prediction?.climateProbability;
      if (probability != null) {
        brierSum += (probability - (label.climate ? 1 : 0)) ** 2;
        brierCount++;
      }
    }

    if (label.climate && label.primaryLabelled) {
      primaryTotal++;
      const predicted = decision?.categories ?? [];
      if (decision) {
        if (decision.primary === label.primary) primaryExact++;
        if (
          decision.primary === label.primary ||
          (decision.primary !== null &&
            label.categories.includes(decision.primary))
        ) {
          primaryLenient++;
        }
      }
      for (const slug of predicted) {
        if (label.categories.includes(slug)) labelTp++;
        else labelFp++;
      }
      for (const slug of label.categories) {
        if (!predicted.includes(slug)) labelFn++;
      }
    }

    if (label.articleType) {
      typeTotal++;
      if (prediction?.ok && prediction.articleType === label.articleType) {
        typeCorrect++;
      }
    }
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const labelPrecision = ratio(labelTp, labelTp + labelFp);
  const labelRecall = ratio(labelTp, labelTp + labelFn);

  return {
    armId,
    labelled: labels.length,
    failed,
    relevance: {
      tp,
      fp,
      tn,
      fn,
      accuracy: ratio(tp + tn, labels.length),
      precision,
      recall,
      f1: f1Score(precision, recall),
      brier: ratio(brierSum, brierCount),
    },
    primary: {
      total: primaryTotal,
      exact: primaryExact,
      lenient: primaryLenient,
      exactAccuracy: ratio(primaryExact, primaryTotal),
      lenientAccuracy: ratio(primaryLenient, primaryTotal),
    },
    multiLabel: {
      tp: labelTp,
      fp: labelFp,
      fn: labelFn,
      precision: labelPrecision,
      recall: labelRecall,
      f1: f1Score(labelPrecision, labelRecall),
    },
    articleType: producesArticleType
      ? {
          total: typeTotal,
          correct: typeCorrect,
          accuracy: ratio(typeCorrect, typeTotal),
        }
      : null,
  };
}

export function buildFinalSummaryMarkdown(
  rawPredictions: ArmPrediction[],
  reviewRows: Array<Record<string, string>>,
  thresholds: Thresholds,
) {
  // Runs written before ids were normalized stored them as strings.
  const predictions = rawPredictions.map((prediction) => ({
    ...prediction,
    articleId: Number(prediction.articleId),
  }));
  const armIds = discoverArmIds(predictions);
  const { labels, warnings } = parseGoldLabels(reviewRows);
  const labelledIds = new Set(labels.map((l) => l.articleId));
  const labelledDisagreements = reviewRows.filter(
    (row) =>
      labelledIds.has(Number(row.article_id)) && row.arms_disagree === "yes",
  ).length;
  const scores = armIds.map((armId) =>
    scoreArm(armId, predictions, labels, thresholds),
  );
  const tunableArmIds = armIds.filter((armId) =>
    predictions.some((p) => p.armId === armId && p.kind !== "production"),
  );

  const lines = [
    "# Categorization Eval: Final Report",
    "",
    `Labelled rows: ${labels.length} of ${reviewRows.length} sampled`,
    `Labelled rows where arms disagreed: ${labelledDisagreements}`,
    `Thresholds: climate ${thresholds.climate}, category ${thresholds.category} (production uses its own rules)`,
    "",
  ];

  if (labels.length === 0) {
    lines.push(
      "No labels found. Fill `label_climate` in review.csv and rerun.",
      "",
    );
    return lines.join("\n");
  }

  if (warnings.length > 0) {
    lines.push("## Label warnings", "");
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push(
    "## Climate relevance",
    "",
    "| Arm | Accuracy | Precision | Recall | F1 | Brier | False positives | False negatives | Failed calls |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const s of scores) {
    lines.push(
      `| ${s.armId} | ${formatPct(s.relevance.accuracy)} | ${formatPct(s.relevance.precision)} | ${formatPct(s.relevance.recall)} | ${formatPct(s.relevance.f1)} | ${s.relevance.brier?.toFixed(3) ?? "n/a"} | ${s.relevance.fp} | ${s.relevance.fn} | ${s.failed} |`,
    );
  }

  lines.push(
    "",
    "Brier is the mean squared error of the climate probability; lower is better.",
    "",
    "## Primary category",
    "",
    "Climate articles with a primary label only. Lenient also accepts a labelled secondary category.",
    "",
    "| Arm | Exact | Lenient | Articles |",
    "| --- | --- | --- | --- |",
  );
  for (const s of scores) {
    lines.push(
      `| ${s.armId} | ${formatPct(s.primary.exactAccuracy)} | ${formatPct(s.primary.lenientAccuracy)} | ${s.primary.total} |`,
    );
  }

  lines.push(
    "",
    "## All assigned categories",
    "",
    "Every category an arm assigned, against primary plus secondary labels. Precision is understated if secondary labels were left blank.",
    "",
    "| Arm | Precision | Recall | F1 |",
    "| --- | --- | --- | --- |",
  );
  for (const s of scores) {
    lines.push(
      `| ${s.armId} | ${formatPct(s.multiLabel.precision)} | ${formatPct(s.multiLabel.recall)} | ${formatPct(s.multiLabel.f1)} |`,
    );
  }

  const typeScores = scores.filter((s) => s.articleType !== null);
  if (typeScores.some((s) => s.articleType!.total > 0)) {
    lines.push(
      "",
      "## Article type",
      "",
      "| Arm | Accuracy | Articles |",
      "| --- | --- | --- |",
    );
    for (const s of typeScores) {
      lines.push(
        `| ${s.armId} | ${formatPct(s.articleType!.accuracy)} | ${s.articleType!.total} |`,
      );
    }
  }

  const kindsLabelled = STORY_KINDS.filter((kind) =>
    labels.some((label) => label.storyKind === kind),
  );
  if (kindsLabelled.length > 0) {
    lines.push(
      "",
      "## Relevance by kind of story",
      "",
      "Share of relevance calls each arm got right, for impact and weather stories. Routine and side story are the two kinds that should be left out.",
      "",
      `| Arm | ${kindsLabelled.map((kind) => `${kind} (${labels.filter((l) => l.storyKind === kind).length})`).join(" | ")} |`,
      `| --- | ${kindsLabelled.map(() => "---").join(" | ")} |`,
    );
    for (const armId of armIds) {
      const cells = kindsLabelled.map((kind) =>
        formatPct(
          scoreArm(
            armId,
            predictions,
            labels.filter((label) => label.storyKind === kind),
            thresholds,
          ).relevance.accuracy,
        ),
      );
      lines.push(`| ${armId} | ${cells.join(" | ")} |`);
    }
  }

  if (tunableArmIds.length > 0) {
    lines.push(
      "",
      "## Threshold sweep",
      "",
      "Picked on the same rows it is scored on, so the best figure is optimistic.",
      "",
      `| Arm | Metric | ${SWEEP_THRESHOLDS.join(" | ")} |`,
      `| --- | --- | ${SWEEP_THRESHOLDS.map(() => "---").join(" | ")} |`,
    );
    for (const armId of tunableArmIds) {
      const relevanceF1 = SWEEP_THRESHOLDS.map((t) =>
        formatPct(
          scoreArm(armId, predictions, labels, { ...thresholds, climate: t })
            .relevance.f1,
        ),
      );
      const primaryExact = SWEEP_THRESHOLDS.map((t) =>
        formatPct(
          scoreArm(armId, predictions, labels, { ...thresholds, category: t })
            .primary.exactAccuracy,
        ),
      );
      const categoryF1 = SWEEP_THRESHOLDS.map((t) =>
        formatPct(
          scoreArm(armId, predictions, labels, { ...thresholds, category: t })
            .multiLabel.f1,
        ),
      );
      lines.push(
        `| ${armId} | Relevance F1 by climate threshold | ${relevanceF1.join(" | ")} |`,
        `| ${armId} | Primary exact by category threshold | ${primaryExact.join(" | ")} |`,
        `| ${armId} | Categories F1 by category threshold | ${categoryF1.join(" | ")} |`,
      );
    }
  }

  lines.push(
    "",
    "## Speed and cost",
    "",
    "All sampled articles, not only labelled ones.",
    "",
    ...speedAndCostLines(predictions, armIds),
    "",
    "## Reading this",
    "",
    "- A failed call counts as a wrong answer in accuracy figures.",
    "- If mostly disagreement rows were labelled, absolute accuracy is pessimistic for every arm; the ranking between arms still holds.",
    "",
  );

  return lines.join("\n");
}

function parseThreshold(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mode: "generate",
    sampleSize: DEFAULT_SAMPLE_SIZE,
    windowDays: DEFAULT_WINDOW_DAYS,
    concurrency: DEFAULT_CONCURRENCY,
    seed: DEFAULT_SEED,
    thresholds: {
      climate: DEFAULT_CLIMATE_THRESHOLD,
      category: DEFAULT_CATEGORY_THRESHOLD,
    },
    labelsFile: DEFAULT_LABELS_FILE,
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

    match = parseCliArg(argv, i, "--arms");
    if (match) {
      opts.arms = match.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--sample-from");
    if (match) {
      if (match.value) opts.sampleFrom = match.value;
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--labels");
    if (match) {
      if (match.value) opts.labelsFile = path.basename(match.value);
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--seed");
    if (match) {
      if (match.value) opts.seed = match.value;
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--climate-threshold");
    if (match) {
      opts.thresholds.climate = parseThreshold(
        match.value,
        opts.thresholds.climate,
      );
      i += match.skip;
      continue;
    }

    match = parseCliArg(argv, i, "--category-threshold");
    if (match) {
      opts.thresholds.category = parseThreshold(
        match.value,
        opts.thresholds.category,
      );
      i += match.skip;
      continue;
    }
  }

  return opts;
}

function resolveArms(opts: CliOptions): CategorizeEvalArm[] {
  if (!opts.arms || opts.arms.length === 0) return DEFAULT_CATEGORIZE_EVAL_ARMS;
  const all = [...DEFAULT_CATEGORIZE_EVAL_ARMS, ...EXTRA_CATEGORIZE_EVAL_ARMS];
  const filtered = all.filter((arm) => opts.arms!.includes(arm.id));
  if (filtered.length === 0) {
    const available = all.map((arm) => arm.id).join(", ");
    throw new Error(`No matching arms. Available: ${available}`);
  }
  return filtered;
}

async function writeArtifacts(
  outDir: string,
  sample: SampleRecord[],
  predictions: ArmPrediction[],
  thresholds: Thresholds,
) {
  await mkdir(outDir, { recursive: true });
  const armIds = discoverArmIds(predictions);

  await writeFile(path.join(outDir, "sample.jsonl"), toJsonl(sample), "utf8");
  await writeFile(
    path.join(outDir, "outputs.jsonl"),
    toJsonl(predictions),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "comparison.csv"),
    stringifyCsv(
      buildComparisonRows(sample, predictions, armIds, thresholds),
      comparisonColumns(armIds),
    ),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "review.csv"),
    stringifyCsv(buildReviewRows(sample, predictions, thresholds), [
      ...REVIEW_COLUMNS,
    ]),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "REVIEW_GUIDE.md"),
    buildReviewGuideMarkdown(outDir),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "summary.auto.md"),
    buildAutoSummaryMarkdown(sample, predictions, thresholds),
    "utf8",
  );
}

async function readSampleIds(runDir: string): Promise<number[]> {
  const raw = await readFile(path.join(runDir, "sample.jsonl"), "utf8");
  return parseJsonl<SampleRecord>(raw).map((record) =>
    Number(record.articleId),
  );
}

/** review.csv reports to summary.final.md; any other label file to its own. */
function reportFileName(labelsFile: string) {
  if (labelsFile === DEFAULT_LABELS_FILE) return "summary.final.md";
  return `summary.${labelsFile.replace(/\.csv$/i, "")}.md`;
}

async function generateEval(opts: CliOptions) {
  const outDir = opts.outDir || defaultEvalOutDir("categorize-evals");
  const arms = resolveArms(opts);

  if (arms.some((arm) => arm.kind === "production")) {
    await assertProductionArmIsReadOnly();
  }

  const rows = opts.sampleFrom
    ? await fetchCategorizeEvalRowsByIds(await readSampleIds(opts.sampleFrom))
    : await fetchCategorizeEvalSample({
        limit: opts.sampleSize,
        recentDays: opts.windowDays,
        seed: opts.seed,
      });
  const candidates = rows.map(prepareCategorizeCandidate);

  console.log(
    `🧪 Running categorization eval on ${candidates.length} articles across ${arms.length} arms...`,
  );

  let done = 0;
  const nested = await mapLimit(
    candidates,
    opts.concurrency,
    async (candidate) => {
      const results = await Promise.all(
        arms.map((arm) => executeCategorizeArm(candidate, arm)),
      );
      done++;
      if (done % 25 === 0) {
        console.log(`  ⏳ Progress: ${done}/${candidates.length}`);
      }
      return results;
    },
  );

  await writeArtifacts(
    outDir,
    candidates.map(toSampleRecord),
    nested.flat(),
    opts.thresholds,
  );

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
  const reviewRaw = await readFile(path.join(outDir, opts.labelsFile), "utf8");
  const reportPath = path.join(outDir, reportFileName(opts.labelsFile));

  await writeFile(
    reportPath,
    buildFinalSummaryMarkdown(
      parseJsonl<ArmPrediction>(outputsRaw),
      parseCsv(reviewRaw),
      opts.thresholds,
    ),
    "utf8",
  );

  console.log(`✅ Final report written to ${reportPath}`);
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
