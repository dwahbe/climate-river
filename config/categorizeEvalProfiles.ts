import {
  ARTICLE_TYPES,
  CATEGORY_SCOPES,
  RELEVANCE_QUESTION,
  type ArticleType,
} from "@/lib/articleJudgment";
import type { CategorySlug } from "@/lib/tagger";

export { ARTICLE_TYPES, type ArticleType };

export type InstructionSetId = "baseline" | "rubric" | "composite";

export type CategorizeEvalArm =
  | {
      id: string;
      /** Current production path: keyword gate + rules + embedding similarity. */
      kind: "production";
    }
  | {
      id: string;
      /** The production call itself: `judgeArticle` in lib/articleJudgment.ts. */
      kind: "judgment";
    }
  | {
      id: string;
      /** Typed-question evaluation model (AI SDK `experimental_evaluate`). */
      kind: "evaluation";
      /** AI Gateway evaluation model ID, e.g. "typesafe-ai/jev" */
      modelId: string;
      instructions: InstructionSetId;
    }
  | {
      id: string;
      /** Chat model returning the same judgments as structured JSON. */
      kind: "language";
      /** AI SDK provider key: "openai", "gateway", etc. */
      provider: string;
      modelId: string;
      instructions: InstructionSetId;
      temperature: number;
      maxOutputTokens: number;
    };

const GPT_41_MINI = {
  kind: "language",
  provider: "gateway",
  modelId: "openai/gpt-4.1-mini",
  temperature: 0,
  maxOutputTokens: 400,
} as const;

const JEV = { kind: "evaluation", modelId: "typesafe-ai/jev" } as const;

/**
 * Arms that run by default. Pricing lives in MODEL_PRICING
 * (config/evalProfiles.ts), keyed by modelId.
 */
export const DEFAULT_CATEGORIZE_EVAL_ARMS: CategorizeEvalArm[] = [
  { id: "production-hybrid", kind: "production" },
  { id: "jev-production", kind: "judgment" },
  { id: "gpt-4.1-mini", ...GPT_41_MINI, instructions: "rubric" },
];

/** Selectable with --arms: earlier question designs, kept for comparison. */
export const EXTRA_CATEGORIZE_EVAL_ARMS: CategorizeEvalArm[] = [
  { id: "jev-rubric", ...JEV, instructions: "rubric" },
  { id: "jev-composite", ...JEV, instructions: "composite" },
  { id: "gpt-4.1-mini-composite", ...GPT_41_MINI, instructions: "composite" },
  { id: "jev-baseline", ...JEV, instructions: "baseline" },
  { id: "gpt-4.1-mini-baseline", ...GPT_41_MINI, instructions: "baseline" },
];

/**
 * Narrow yes/no questions that together decide relevance. Each asks one
 * thing, read literally; `combineRelevanceSignals` in
 * scripts/categorize-eval.ts holds the logic. An experiment: the single
 * production question scored as well or better (2026-09-28).
 */
export const RELEVANCE_SIGNALS = {
  scope_science:
    "Is this article mainly about climate change, global warming, climate science, or greenhouse gas emissions?",
  scope_energy:
    "Is this article mainly about energy: renewables, energy storage, electric vehicles, the power grid, nuclear power, hydrogen, carbon capture or removal, critical minerals or deep-sea mining, or the oil, gas, or coal industry?",
  scope_policy:
    "Is this article mainly about climate, energy, or emissions policy: laws, regulation, permits, court cases, elections, or international negotiations?",
  scope_finance:
    "Is this article mainly about climate finance, carbon markets or carbon credits, ESG, or a company's climate or emissions targets?",
  scope_adaptation:
    "Is this article mainly about preparing for or adapting to floods, wildfires, heat, drought, storms, or sea level rise, such as flood defences, early warning systems, or preparedness advice?",
  impact_signal:
    "Is this article mainly about a measured change in the climate system or an ecosystem, such as air or ocean temperature records, sea level, ice loss, coral bleaching, or a seasonal outlook such as El Niño?",
  impact_linked:
    "Does the text itself say that climate change or global warming is a cause of, or a factor in, the event or problem it describes?",
  weather_event:
    "Is this article mainly about a flood, wildfire, heat wave, storm, hurricane, or drought?",
  weather_forecast:
    "Is this article a weather forecast, watch, warning, advisory, or storm tracker, about weather that is expected rather than weather that has already happened?",
  weather_scale:
    "Does the text report at least one of: deaths, injuries, or missing people; evacuations or rescues; damage to homes, farms, or infrastructure; a broken record, or severity described as extreme, exceptional, or severe; a disaster declaration, emergency measure, or aid; an affected area of several counties, a state, a region, or a country; a named hurricane or tropical storm?",
  side_story:
    "Is this article mainly about a fundraiser or charity effort, an arrest or criminal case, a sports result, or a community event, rather than about the disaster or weather itself?",
} as const;

export type RelevanceSignal = keyof typeof RELEVANCE_SIGNALS;

export type CategorizeInstructionSet = {
  /** One relevance question, or the RELEVANCE_SIGNALS combined in code. */
  relevance: { mode: "single"; question: string } | { mode: "signals" };
  /** Scope per category. Omitted: the category description in lib/tagger.ts. */
  categories?: Record<CategorySlug, string>;
};

export const CATEGORIZE_INSTRUCTION_SETS: Record<
  InstructionSetId,
  CategorizeInstructionSet
> = {
  baseline: {
    relevance: {
      mode: "single",
      question:
        "Is this news article substantively about climate change, the energy transition, or climate-related environmental policy, science, or impacts?",
    },
  },
  // The production questions (lib/articleJudgment.ts), without its pick-one
  // category question.
  rubric: {
    relevance: { mode: "single", question: RELEVANCE_QUESTION },
    categories: CATEGORY_SCOPES,
  },
  composite: {
    relevance: { mode: "signals" },
    categories: CATEGORY_SCOPES,
  },
};

export const DEFAULT_CLIMATE_THRESHOLD = 0.5;
export const DEFAULT_CATEGORY_THRESHOLD = 0.5;
