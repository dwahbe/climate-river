// lib/articleJudgment.ts
// One model call per article: relevance, category, language, and article type.
// Single source of truth for the questions. scripts/judge.ts (shadow mode for
// now) and the categorize:eval harness both import them, so the bakeoff
// measures exactly what production asks. Restates docs/categorization.md;
// change both together and bump RUBRIC_VERSION.

import {
  JEV_MODEL_ID,
  booleanProbability,
  evaluateWithJev,
  isChoiceTieError,
  type JevAnswer,
  type JevEvaluateFn,
  type JevQuestion,
} from "@/lib/jev";
import {
  CATEGORIES,
  normalizeArticleForCategorization,
  type CategorySlug,
} from "@/lib/tagger";

export const JUDGMENT_MODEL_ID = JEV_MODEL_ID;
export { isChoiceTieError };
export const RUBRIC_VERSION = "2026-09-28";

const SUMMARY_MAX_CHARS = 2000;
const CALL_TIMEOUT_MS = 20_000;
const CATEGORY_THRESHOLD = 0.5;

export const CATEGORY_SLUGS: CategorySlug[] = CATEGORIES.map((c) => c.slug);

export const ARTICLE_TYPES = {
  news_report: "News reporting, feature, or analysis by a news outlet",
  opinion: "Opinion, editorial, or commentary",
  press_release:
    "Press release or announcement written from the organization's point of view, including trade-press rewrites of one",
  promotional: "Stock tip, sponsored, or promotional content",
  not_news:
    "Not an article: event page, correction, tracker, how-to guide, or listing",
} as const;

export type ArticleType = keyof typeof ARTICLE_TYPES;
export const ARTICLE_TYPE_KEYS = Object.keys(ARTICLE_TYPES) as ArticleType[];

export const RELEVANCE_QUESTION = [
  "Does this article belong on a climate news site?",
  "Yes when it is mainly about: climate change or climate science; greenhouse gas emissions or the fossil fuel industry; the energy transition (renewables, storage, electric vehicles, the power grid, nuclear, hydrogen, carbon capture and removal, critical minerals), with or without any mention of climate; climate policy, law, lawsuits, or diplomacy; climate finance, carbon markets, or corporate climate targets; adaptation to floods, fires, heat, drought, storms, or sea level rise.",
  "Yes for a measured change in the climate system or an ecosystem, such as temperature records, sea level, ice loss, or coral bleaching, and for any event or problem the text itself links to climate change.",
  "Yes for a flood, wildfire, heat wave, storm, or drought that has happened or is under way when the text reports at least one of: deaths, injuries, or people missing; evacuations or rescues; damage to homes, farms, or infrastructure; a broken record or a severity word such as extreme or exceptional; a disaster declaration, emergency measure, or request for aid; a wide area such as several counties, a state, a region, or a country; a named hurricane or tropical storm.",
  "No for weather forecasts, watches, warnings, advisories, and trackers; for weather with none of those signs, including traffic disruption and street flooding alone; for side stories such as fundraisers, arrests, and community events; for nature, wildlife, or general environment stories with no climate link; and when a climate law or body is only the backdrop to another topic.",
].join(" ");

export const ENGLISH_QUESTION =
  "Is this headline written in English? Names of people, places, and organizations in other languages do not make it non-English.";

export const PRIMARY_QUESTION =
  "Which single category fits this article best? Pick the category of what happened, not of who reported it.";

export const CATEGORY_SCOPES: Record<CategorySlug, string> = {
  government:
    "Laws, regulation, executive action, permits, elections and politicians' positions, international negotiations, public agencies and development banks, and court cases brought by or against governments. Not company responses to policy.",
  justice:
    "Protests, strikes, direct action, campaigns by movements and advocacy groups, climate justice claims by affected communities, and lawsuits brought by activists, youth, or communities. Not statements by governments.",
  business:
    "Corporate targets and announcements, deals, investment, carbon markets, ESG, and industry and market trends. Not technology described on its own merits.",
  impacts:
    "Measured changes in the climate system or ecosystems; events or problems the text links to climate change; notable floods, wildfires, heat waves, storms, and droughts; and adaptation to them. Not studies whose news is the finding itself.",
  tech: "Clean energy and climate technology: projects, products, deployments, engineering advances, cost and performance. Not funding rounds or corporate strategy.",
  research:
    "Peer-reviewed studies, scientific reports, new data and models, when the finding itself is the news. Not reports by advocacy groups or companies.",
};

export type PrimaryChoice = CategorySlug | "none";

export type ArticleJudgment = {
  climateP: number;
  englishP: number;
  primary: PrimaryChoice;
  /** Null when the pick-one question was dropped and primary came from categoryP. */
  primaryP: Partial<Record<PrimaryChoice, number>> | null;
  categoryP: Record<CategorySlug, number>;
  articleType: ArticleType | null;
  articleTypeP: Partial<Record<ArticleType, number>> | null;
};

export type JudgmentInput = { title: string; summary: string | null };

export type JudgmentResult = {
  judgment: ArticleJudgment;
  inputTokens: number | null;
  latencyMs: number;
  /** True when the pick-one questions tied and the call was retried without them. */
  usedFallback: boolean;
};

export type EvaluateFn = JevEvaluateFn;

/** The text every judge sees: title plus dek and content, as categorize builds it. */
export function buildJudgmentInput(
  title: string,
  dek?: string | null,
  contentText?: string | null,
): JudgmentInput {
  const summary =
    [dek, contentText].filter(Boolean).join(" ").slice(0, SUMMARY_MAX_CHARS) ||
    undefined;
  const normalized = normalizeArticleForCategorization({ title, summary });
  return { title: normalized.title, summary: normalized.summary ?? null };
}

export function categoryQuestion(slug: CategorySlug): string {
  const category = CATEGORIES.find((c) => c.slug === slug)!;
  return `Does this article belong in the "${category.name}" category? ${CATEGORY_SCOPES[slug]}`;
}

function categoryQuestionId(slug: CategorySlug) {
  return `category_${slug}`;
}

/** `choices: false` drops the two pick-one questions (see judgeArticle). */
export function buildJudgmentQuestions(
  opts: { choices?: boolean } = {},
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    climate: { type: "boolean", instructions: RELEVANCE_QUESTION },
    english: { type: "boolean", instructions: ENGLISH_QUESTION },
  };
  for (const slug of CATEGORY_SLUGS) {
    questions[categoryQuestionId(slug)] = {
      type: "boolean",
      instructions: categoryQuestion(slug),
    };
  }
  if (opts.choices !== false) {
    questions.primary = {
      type: "choice",
      instructions: PRIMARY_QUESTION,
      criteria: {
        ...Object.fromEntries(
          CATEGORIES.map((c) => [
            c.slug,
            `${c.name}. ${CATEGORY_SCOPES[c.slug]}`,
          ]),
        ),
        none: "None of these categories fits.",
      },
    };
    questions.article_type = {
      type: "choice",
      instructions: "What kind of article is this?",
      criteria: ARTICLE_TYPES,
    };
  }
  return questions;
}

function isPrimaryChoice(value: string): value is PrimaryChoice {
  return value === "none" || (CATEGORY_SLUGS as string[]).includes(value);
}

function isArticleType(value: string): value is ArticleType {
  return (ARTICLE_TYPE_KEYS as string[]).includes(value);
}

/** Highest yes/no category at or above the threshold, else none. */
export function primaryFromCategories(
  categoryP: Record<CategorySlug, number>,
): PrimaryChoice {
  const best = CATEGORY_SLUGS.reduce((top, slug) =>
    categoryP[slug] > categoryP[top] ? slug : top,
  );
  return categoryP[best] >= CATEGORY_THRESHOLD ? best : "none";
}

export function parseJudgmentAnswers(
  answers: Record<string, JevAnswer>,
): ArticleJudgment {
  const categoryP = Object.fromEntries(
    CATEGORY_SLUGS.map((slug) => [
      slug,
      booleanProbability(answers, categoryQuestionId(slug)),
    ]),
  ) as Record<CategorySlug, number>;

  const primaryAnswer = answers.primary;
  const pickedPrimary =
    primaryAnswer?.type === "choice" && isPrimaryChoice(primaryAnswer.choice)
      ? primaryAnswer
      : null;
  const typeAnswer = answers.article_type;
  const pickedType =
    typeAnswer?.type === "choice" && isArticleType(typeAnswer.choice)
      ? typeAnswer
      : null;

  return {
    climateP: booleanProbability(answers, "climate"),
    englishP: booleanProbability(answers, "english"),
    primary: pickedPrimary
      ? (pickedPrimary.choice as PrimaryChoice)
      : primaryFromCategories(categoryP),
    primaryP: pickedPrimary?.probabilities ?? null,
    categoryP,
    articleType: pickedType ? (pickedType.choice as ArticleType) : null,
    articleTypeP: pickedType?.probabilities ?? null,
  };
}

/**
 * Judge one article. Throws on transport or parse failure; callers decide
 * whether to retry. A tie on a pick-one question is retried once without those
 * questions, so one ambiguous article type cannot cost the whole judgment.
 */
export async function judgeArticle(
  input: JudgmentInput,
  opts: { evaluateFn?: EvaluateFn; timeoutMs?: number } = {},
): Promise<JudgmentResult> {
  const evaluateFn = opts.evaluateFn ?? evaluateWithJev;
  const started = Date.now();
  const call = (choices: boolean) =>
    evaluateFn({
      state: input,
      questions: buildJudgmentQuestions({ choices }),
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
    });

  let usedFallback = false;
  let response: Awaited<ReturnType<EvaluateFn>>;
  try {
    response = await call(true);
  } catch (error) {
    if (!isChoiceTieError(error)) throw error;
    usedFallback = true;
    response = await call(false);
  }

  return {
    judgment: parseJudgmentAnswers(response.answers),
    inputTokens: response.inputTokens,
    latencyMs: Date.now() - started,
    usedFallback,
  };
}
