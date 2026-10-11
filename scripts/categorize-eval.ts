// scripts/categorize-eval.ts
// Arm execution for the categorization bakeoff (scripts/categorize-bakeoff.ts).
// Read-only against the database: the production arm reuses stored embeddings
// and refuses to run when it would have to generate and persist them.

import {
  experimental_evaluate as evaluate,
  gateway,
  generateText,
  jsonSchema,
  Output,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";

import {
  ARTICLE_TYPES,
  CATEGORIZE_INSTRUCTION_SETS,
  RELEVANCE_SIGNALS,
  type ArticleType,
  type CategorizeEvalArm,
  type InstructionSetId,
  type RelevanceSignal,
} from "@/config/categorizeEvalProfiles";
import { MODEL_PRICING } from "@/config/evalProfiles";
import { isTrustedClimateSource } from "@/config/trustedClimateSources";
import {
  ARTICLE_TYPE_KEYS,
  CATEGORY_SLUGS,
  JUDGMENT_MODEL_ID,
  buildJudgmentInput,
  judgeArticle,
  type PrimaryChoice,
} from "@/lib/articleJudgment";
import {
  categorizeArticleHybrid,
  filterStorableCategoryScores,
} from "@/lib/categorizer";
import { query } from "@/lib/db";
import { resolveModel } from "@/lib/evalProviders";
import { visibleLanguagePredicate } from "@/lib/languagePolicy";
import { CATEGORIES, isClimateRelevant, type CategorySlug } from "@/lib/tagger";

const CALL_TIMEOUT_MS = 20_000;
const SUMMARY_MAX_CHARS = 2000;

export { ARTICLE_TYPE_KEYS, CATEGORY_SLUGS } from "@/lib/articleJudgment";
export const RELEVANCE_SIGNAL_KEYS = Object.keys(
  RELEVANCE_SIGNALS,
) as RelevanceSignal[];

/** Why an article counts as an impact of climate. See docs/categorization.md. */
export const IMPACT_KINDS = [
  "signal",
  "linked",
  "event",
  "adaptation",
] as const;
export type ImpactKind = (typeof IMPACT_KINDS)[number];

export type CategorizeEvalRow = {
  id: number;
  title: string;
  dek: string | null;
  content_text: string | null;
  canonical_url: string;
  published_at: Date | string | null;
  source_name: string | null;
  feed_url: string | null;
  homepage_url: string | null;
  stored_primary: string | null;
  categorize_status: string | null;
};

export type CategorizeEvalCandidate = {
  row: CategorizeEvalRow;
  /** Same text production categorization sees: dek + content, capped. */
  rawSummary: string | undefined;
  title: string;
  summary: string | null;
  trusted: boolean;
};

export type ArmPrediction = {
  articleId: number;
  armId: string;
  kind: CategorizeEvalArm["kind"];
  model: string | null;
  ok: boolean;
  error: string | null;
  /** Production arm reports its gate as 0 or 1. */
  climateProbability: number | null;
  categoryProbabilities: Partial<Record<CategorySlug, number>>;
  /** Production only: storable categories in ranked order, by its own rules. */
  rankedCategories: CategorySlug[] | null;
  /** Judgment arm only: the answer to the pick-one category question. */
  primaryChoice: PrimaryChoice | null;
  englishProbability: number | null;
  articleType: ArticleType | null;
  articleTypeProbabilities: Partial<Record<ArticleType, number>> | null;
  /** Signal arms only: the raw answers behind climateProbability. */
  relevanceSignals: Partial<Record<RelevanceSignal, number>> | null;
  impactKind: ImpactKind | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export type Thresholds = { climate: number; category: number };

export type ArmDecision = {
  climate: boolean;
  /** Assigned categories, primary first. Empty when not climate. */
  categories: CategorySlug[];
  primary: CategorySlug | null;
  articleType: ArticleType | null;
};

/** Turn raw probabilities into decisions. Returns null for failed calls. */
export function decide(
  prediction: ArmPrediction,
  thresholds: Thresholds,
): ArmDecision | null {
  if (!prediction.ok || prediction.climateProbability == null) return null;

  const climate = prediction.climateProbability >= thresholds.climate;
  if (!climate) {
    return {
      climate,
      categories: [],
      primary: null,
      articleType: prediction.articleType,
    };
  }

  const aboveThreshold = CATEGORY_SLUGS.filter(
    (slug) =>
      (prediction.categoryProbabilities[slug] ?? 0) >= thresholds.category,
  ).sort(
    (a, b) =>
      (prediction.categoryProbabilities[b] ?? 0) -
      (prediction.categoryProbabilities[a] ?? 0),
  );
  const picked = prediction.primaryChoice;
  const categories =
    prediction.rankedCategories ??
    (picked === "none"
      ? []
      : picked
        ? [picked, ...aboveThreshold.filter((slug) => slug !== picked)]
        : aboveThreshold);

  return {
    climate,
    categories,
    primary: categories[0] ?? null,
    articleType: prediction.articleType,
  };
}

/**
 * Relevance from narrow signals. An article is in when any path holds: a core
 * topic, a measured climate signal, a stated climate link, a notable weather
 * event, or adaptation. Forecasts and side stories veto the last two.
 */
export function combineRelevanceSignals(
  signals: Record<RelevanceSignal, number>,
): { climate: number; impactKind: ImpactKind | null } {
  const notForecast = 1 - signals.weather_forecast;
  const notSideStory = 1 - signals.side_story;

  const core = Math.max(
    signals.scope_science,
    signals.scope_energy,
    signals.scope_policy,
    signals.scope_finance,
  );
  const impacts: Record<ImpactKind, number> = {
    signal: signals.impact_signal,
    linked: signals.impact_linked,
    event: Math.min(
      signals.weather_event,
      signals.weather_scale,
      notForecast,
      notSideStory,
    ),
    adaptation: Math.min(signals.scope_adaptation, notForecast, notSideStory),
  };

  const strongest = IMPACT_KINDS.reduce((best, kind) =>
    impacts[kind] > impacts[best] ? kind : best,
  );

  return {
    climate: Math.max(core, impacts[strongest]),
    impactKind: impacts[strongest] >= 0.5 ? strongest : null,
  };
}

export function categoryInstructions(
  category: (typeof CATEGORIES)[number],
  instructions: InstructionSetId,
) {
  const scope =
    CATEGORIZE_INSTRUCTION_SETS[instructions].categories?.[category.slug] ??
    `${category.description}.`;
  return `Does this article belong in the "${category.name}" category? ${scope}`;
}

function categoryQuestionId(slug: CategorySlug) {
  return `category_${slug}`;
}

function signalQuestionId(signal: RelevanceSignal) {
  return `signal_${signal}`;
}

export function buildEvaluationQuestions(
  instructions: InstructionSetId,
): Record<string, EvaluationQuestion> {
  const { relevance } = CATEGORIZE_INSTRUCTION_SETS[instructions];
  const questions: Record<string, EvaluationQuestion> = {
    article_type: {
      type: "choice",
      instructions: "What kind of article is this?",
      criteria: ARTICLE_TYPES,
    },
  };
  if (relevance.mode === "single") {
    questions.climate = { type: "boolean", instructions: relevance.question };
  } else {
    for (const signal of RELEVANCE_SIGNAL_KEYS) {
      questions[signalQuestionId(signal)] = {
        type: "boolean",
        instructions: RELEVANCE_SIGNALS[signal],
      };
    }
  }
  for (const category of CATEGORIES) {
    questions[categoryQuestionId(category.slug)] = {
      type: "boolean",
      instructions: categoryInstructions(category, instructions),
    };
  }
  return questions;
}

type LanguageArmOutput = {
  climate?: number;
  signals?: Record<RelevanceSignal, number>;
  categories: Record<CategorySlug, number>;
  articleType: ArticleType;
};

function probabilityObject(keys: string[]) {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(
      keys.map((key) => [key, { type: "number" as const }]),
    ),
  };
}

function languageArmSchema(instructions: InstructionSetId) {
  const single =
    CATEGORIZE_INSTRUCTION_SETS[instructions].relevance.mode === "single";
  return jsonSchema<LanguageArmOutput>({
    type: "object",
    additionalProperties: false,
    required: [single ? "climate" : "signals", "categories", "articleType"],
    properties: {
      ...(single
        ? { climate: { type: "number" } }
        : { signals: probabilityObject(RELEVANCE_SIGNAL_KEYS) }),
      categories: probabilityObject(CATEGORY_SLUGS),
      articleType: { type: "string", enum: ARTICLE_TYPE_KEYS },
    },
  });
}

export function buildLanguageArmInstructions(instructions: InstructionSetId) {
  const { relevance } = CATEGORIZE_INSTRUCTION_SETS[instructions];
  const categoryLines = CATEGORIES.map(
    (c) => `  - ${c.slug}: ${categoryInstructions(c, instructions)}`,
  ).join("\n");
  const typeLines = ARTICLE_TYPE_KEYS.map(
    (key) => `  - ${key}: ${ARTICLE_TYPES[key]}`,
  ).join("\n");
  const relevanceLines =
    relevance.mode === "single"
      ? [
          `climate: the probability that the answer to this question is yes. ${relevance.question}`,
        ]
      : [
          "signals: for each question, the probability that the answer is yes. Read each question literally and answer it on its own.",
          ...RELEVANCE_SIGNAL_KEYS.map(
            (signal) => `  - ${signal}: ${RELEVANCE_SIGNALS[signal]}`,
          ),
        ];

  return [
    "You classify news articles for a climate news aggregator.",
    "Judge only from the title and summary provided. Every number is a probability between 0 and 1.",
    "",
    ...relevanceLines,
    "",
    "categories: for each category, the probability that the answer is yes. An article can belong to several categories or to none.",
    categoryLines,
    "",
    "articleType: the single best description of the article.",
    typeLines,
  ].join("\n");
}

function clampProbability(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function isArticleType(value: unknown): value is ArticleType {
  return (
    typeof value === "string" && (ARTICLE_TYPE_KEYS as string[]).includes(value)
  );
}

function estimateCost(
  modelId: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing || (inputTokens == null && outputTokens == null)) return null;
  return (
    ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillion +
    ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillion
  );
}

function relevanceFromSignals(read: (signal: RelevanceSignal) => number) {
  const signals = Object.fromEntries(
    RELEVANCE_SIGNAL_KEYS.map((signal) => [signal, read(signal)]),
  ) as Record<RelevanceSignal, number>;
  return { ...combineRelevanceSignals(signals), signals };
}

function emptyPrediction(
  candidate: CategorizeEvalCandidate,
  arm: CategorizeEvalArm,
): ArmPrediction {
  return {
    articleId: candidate.row.id,
    armId: arm.id,
    kind: arm.kind,
    model:
      arm.kind === "production"
        ? null
        : arm.kind === "judgment"
          ? JUDGMENT_MODEL_ID
          : arm.modelId,
    ok: false,
    error: null,
    climateProbability: null,
    categoryProbabilities: {},
    rankedCategories: null,
    primaryChoice: null,
    englishProbability: null,
    articleType: null,
    articleTypeProbabilities: null,
    relevanceSignals: null,
    impactKind: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
  };
}

async function runProductionArm(
  candidate: CategorizeEvalCandidate,
  base: ArmPrediction,
): Promise<ArmPrediction> {
  const climate =
    candidate.trusted ||
    isClimateRelevant({ title: candidate.title, summary: candidate.summary });

  const scores = filterStorableCategoryScores(
    await categorizeArticleHybrid(
      candidate.row.title,
      candidate.rawSummary,
      candidate.row.id,
      { trusted: candidate.trusted },
    ),
  );

  return {
    ...base,
    ok: true,
    climateProbability: climate ? 1 : 0,
    categoryProbabilities: Object.fromEntries(
      scores.map((score) => [score.slug, score.confidence]),
    ),
    rankedCategories: scores.map((score) => score.slug),
  };
}

async function runJudgmentArm(
  candidate: CategorizeEvalCandidate,
  base: ArmPrediction,
): Promise<ArmPrediction> {
  const { judgment, inputTokens } = await judgeArticle({
    title: candidate.title,
    summary: candidate.summary,
  });

  return {
    ...base,
    ok: true,
    climateProbability: judgment.climateP,
    categoryProbabilities: judgment.categoryP,
    primaryChoice: judgment.primary,
    englishProbability: judgment.englishP,
    articleType: judgment.articleType,
    articleTypeProbabilities: judgment.articleTypeP,
    inputTokens,
    outputTokens: 0,
    estimatedCostUsd: estimateCost(JUDGMENT_MODEL_ID, inputTokens, 0),
  };
}

async function runEvaluationArm(
  candidate: CategorizeEvalCandidate,
  arm: Extract<CategorizeEvalArm, { kind: "evaluation" }>,
  base: ArmPrediction,
): Promise<ArmPrediction> {
  const result = await evaluate({
    model: gateway.evaluationModel(arm.modelId),
    state: { title: candidate.title, summary: candidate.summary },
    questions: buildEvaluationQuestions(arm.instructions),
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  const booleanAnswer = (questionId: string) => {
    const answer = result.answers[questionId];
    if (answer?.type !== "boolean") {
      throw new Error(`evaluation_missing_answer:${questionId}`);
    }
    return answer.probability;
  };

  const relevance =
    CATEGORIZE_INSTRUCTION_SETS[arm.instructions].relevance.mode === "single"
      ? { climate: booleanAnswer("climate"), impactKind: null, signals: null }
      : relevanceFromSignals((signal) =>
          booleanAnswer(signalQuestionId(signal)),
        );

  const categoryProbabilities: Partial<Record<CategorySlug, number>> = {};
  for (const slug of CATEGORY_SLUGS) {
    categoryProbabilities[slug] = booleanAnswer(categoryQuestionId(slug));
  }

  const typeAnswer = result.answers.article_type;
  const articleType =
    typeAnswer?.type === "choice" && isArticleType(typeAnswer.choice)
      ? typeAnswer.choice
      : null;
  const articleTypeProbabilities =
    typeAnswer?.type === "choice" && typeAnswer.probabilities
      ? (typeAnswer.probabilities as Partial<Record<ArticleType, number>>)
      : null;

  const inputTokens = result.usage.inputTokens ?? null;
  const outputTokens = result.usage.outputTokens ?? null;

  return {
    ...base,
    ok: true,
    climateProbability: relevance.climate,
    categoryProbabilities,
    articleType,
    articleTypeProbabilities,
    relevanceSignals: relevance.signals,
    impactKind: relevance.impactKind,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimateCost(arm.modelId, inputTokens, outputTokens),
  };
}

async function runLanguageArm(
  candidate: CategorizeEvalCandidate,
  arm: Extract<CategorizeEvalArm, { kind: "language" }>,
  base: ArmPrediction,
): Promise<ArmPrediction> {
  const model = await resolveModel(arm.provider, arm.modelId);
  const result = await generateText({
    model,
    instructions: buildLanguageArmInstructions(arm.instructions),
    prompt: JSON.stringify({
      title: candidate.title,
      summary: candidate.summary,
    }),
    temperature: arm.temperature,
    maxOutputTokens: arm.maxOutputTokens,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    output: Output.object({ schema: languageArmSchema(arm.instructions) }),
  });

  const output = result.output;
  const probability = (value: unknown, name: string) => {
    const clamped = clampProbability(value);
    if (clamped == null)
      throw new Error(`language_invalid_probability:${name}`);
    return clamped;
  };

  const relevance =
    CATEGORIZE_INSTRUCTION_SETS[arm.instructions].relevance.mode === "single"
      ? {
          climate: probability(output.climate, "climate"),
          impactKind: null,
          signals: null,
        }
      : relevanceFromSignals((signal) =>
          probability(output.signals?.[signal], signal),
        );

  const categoryProbabilities: Partial<Record<CategorySlug, number>> = {};
  for (const slug of CATEGORY_SLUGS) {
    categoryProbabilities[slug] = probability(output.categories?.[slug], slug);
  }

  const inputTokens = result.usage.inputTokens ?? null;
  const outputTokens = result.usage.outputTokens ?? null;

  return {
    ...base,
    ok: true,
    climateProbability: relevance.climate,
    categoryProbabilities,
    articleType: isArticleType(output.articleType) ? output.articleType : null,
    relevanceSignals: relevance.signals,
    impactKind: relevance.impactKind,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimateCost(arm.modelId, inputTokens, outputTokens),
  };
}

/** Run one arm on one article. Never throws: failures land in `error`. */
export async function executeCategorizeArm(
  candidate: CategorizeEvalCandidate,
  arm: CategorizeEvalArm,
): Promise<ArmPrediction> {
  const base = emptyPrediction(candidate, arm);
  const started = Date.now();

  try {
    const prediction =
      arm.kind === "production"
        ? await runProductionArm(candidate, base)
        : arm.kind === "judgment"
          ? await runJudgmentArm(candidate, base)
          : arm.kind === "evaluation"
            ? await runEvaluationArm(candidate, arm, base)
            : await runLanguageArm(candidate, arm, base);
    return { ...prediction, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ...base,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        300,
      ),
      latencyMs: Date.now() - started,
    };
  }
}

export function prepareCategorizeCandidate(
  row: CategorizeEvalRow,
): CategorizeEvalCandidate {
  // The production arm gets the raw text, as scripts/categorize.ts passes it;
  // every model arm gets the production judgment input.
  const rawSummary =
    [row.dek, row.content_text]
      .filter(Boolean)
      .join(" ")
      .slice(0, SUMMARY_MAX_CHARS) || undefined;
  const input = buildJudgmentInput(row.title, row.dek, row.content_text);

  return {
    row,
    rawSummary,
    title: input.title,
    summary: input.summary,
    trusted: isTrustedClimateSource({
      feedUrl: row.feed_url,
      homepageUrl: row.homepage_url,
    }),
  };
}

const SAMPLE_SELECT = `
  select
    a.id,
    a.title,
    a.dek,
    left(a.content_text, ${SUMMARY_MAX_CHARS}) as content_text,
    a.canonical_url,
    a.published_at,
    coalesce(a.publisher_name, s.name) as source_name,
    s.feed_url,
    s.homepage_url,
    (
      select c.slug
      from article_categories ac
      join categories c on c.id = ac.category_id
      where ac.article_id = a.id and ac.is_primary
      limit 1
    ) as stored_primary,
    a.pipeline_state#>>'{categorize,status}' as categorize_status
  from articles a
  left join sources s on s.id = a.source_id
`;

// pg returns bigint ids as strings; labels are matched by numeric id.
function normalizeRows(rows: CategorizeEvalRow[]): CategorizeEvalRow[] {
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/**
 * Deterministic pseudo-random sample of recent articles, categorized or not.
 * Only articles with a stored embedding, so the production arm never writes.
 */
export async function fetchCategorizeEvalSample(opts: {
  limit: number;
  recentDays: number;
  seed: string;
}): Promise<CategorizeEvalRow[]> {
  const recentDays = Math.max(1, Math.floor(opts.recentDays));

  const { rows } = await query<CategorizeEvalRow>(
    `
      ${SAMPLE_SELECT}
      where coalesce(a.published_at, a.fetched_at) > now() - ($2::text || ' days')::interval
        and a.embedding is not null
        and a.title is not null
        and ${visibleLanguagePredicate("a")}
      order by md5(a.id::text || $3)
      limit $1
    `,
    [opts.limit, String(recentDays), opts.seed],
  );
  return normalizeRows(rows);
}

/** The articles of an earlier run, in that run's order, so its labels still apply. */
export async function fetchCategorizeEvalRowsByIds(
  articleIds: number[],
): Promise<CategorizeEvalRow[]> {
  const { rows } = await query<CategorizeEvalRow>(
    `
      ${SAMPLE_SELECT}
      where a.id = any($1::bigint[])
        and a.embedding is not null
    `,
    [articleIds],
  );
  const byId = new Map(normalizeRows(rows).map((row) => [row.id, row]));
  return articleIds
    .map((id) => byId.get(id))
    .filter((row): row is CategorizeEvalRow => row !== undefined);
}

/** The production arm would generate and store any missing category embedding. */
export async function assertProductionArmIsReadOnly(): Promise<void> {
  const { rows } = await query<{ missing: string }>(
    `select count(*)::text as missing from categories where embedding is null`,
  );
  const missing = Number(rows[0]?.missing ?? 0);
  if (missing > 0) {
    throw new Error(
      `${missing} categories have no stored embedding; the production arm would write them. Run the categorize stage once, or drop the production arm with --arms.`,
    );
  }
}
