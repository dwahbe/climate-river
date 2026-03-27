import {
  DEFAULT_EVAL_PROFILES,
  type EvalProfile,
  type PromptVariant,
} from "@/config/evalProfiles";
import { query } from "@/lib/db";
import { resolveModel } from "@/lib/evalProviders";
import { isClimateRelevant } from "@/lib/tagger";
import { generateText } from "ai";

import {
  buildSourceQuantContext,
  extractContentSnippet,
  sanitizeHeadline,
} from "./rewrite";

export type { EvalProfile, PromptVariant } from "@/config/evalProfiles";

export type Row = {
  id: number;
  title: string;
  dek: string | null;
  canonical_url: string;
  content_text: string | null;
  content_html: string | null;
  content_status: string | null;
  published_at: string | null;
  source_name: string | null;
  cluster_score: number | null;
};

export type UsageSnapshot = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export type GenerationResult = {
  text: string | null;
  provider: string;
  modelId: string;
  profileId: string;
  promptVariant: PromptVariant;
  notes: string;
  usage?: UsageSnapshot;
  latencyMs?: number;
  finishReason?: string;
};

type PromptInput = {
  title: string;
  dek?: string | null;
  contentSnippet?: string | null;
  previewExcerpt?: string | null;
  publishedAt?: string | null;
};

type QuantContext = {
  hasQuantEvidence: boolean;
  numbers: Set<string>;
};

export type ValidationContext = {
  hasContent: boolean;
  sourceQuant: QuantContext;
  sourceText: string;
};

export type RewriteFailureCode =
  | "empty_output"
  | "length"
  | "unchanged"
  | "too_short"
  | "too_compressed"
  | "invented_number"
  | "hallucinated_entity"
  | "teaser_clickbait"
  | "unsupported_hedging"
  | "vague_topic_summary"
  | "missing_attribution"
  | "weak_prioritization";

export type RewriteValidationResult =
  | { ok: true; code: null; message: null }
  | { ok: false; code: RewriteFailureCode; message: string };

export type PreparedRewriteCandidate = {
  row: Row;
  promptInput: PromptInput;
  validationContext: ValidationContext;
  contentNote: string;
  isClimate: boolean;
};

export type RewriteAttempt = {
  retry: boolean;
  draft: string;
  validation: RewriteValidationResult;
  generation: GenerationResult;
};

export type RewriteExecutionResult = {
  profile: EvalProfile;
  firstAttempt: RewriteAttempt;
  retryAttempt?: RewriteAttempt;
  finalAttempt: RewriteAttempt;
  success: boolean;
  finalDraft: string;
};

function todayLabel() {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function buildLegacySystemPrompt() {
  return `Today is ${todayLabel()}.

You rewrite climate news headlines in the style of Techmeme: dense, factual, scannable.

RULES:
- Lead with WHO (named entity from the source: "EPA", "Orsted", "9th Circuit") + strong action verb
- Present tense, active voice, no period at end
- 140-200 characters ideal; use commas and semicolons to pack detail
- Only include numbers/dates/measurements that appear in the source material; do not convert relative time ("last year", "this year") into specific years
- NEVER add, replace, or change names of people, politicians, or political figures — use exactly the names and attributions from the source material
- If no numbers exist, stay concrete and qualitative — never pad with filler
- Prefer named entities, policies, products from the source over vague references like "regulators", "a company", "a bank"
- The headline IS the news, not a description of an article about the news
- Match the certainty of the source: facts as facts, projections with "may"/"could"

NEVER USE these vague filler patterns (they will be rejected):
- "aiming to", "impacting", "reflecting", "amid concerns/issues/challenges"
- "detailing", "outlining", "addressing", "emphasizing"
- "faces issues/challenges", "raises concerns/doubts", "sparking debate"
- "building momentum", "gaining traction", "making progress"
- "reports on", "explores", "discusses", "covers"
- "likely", "expected to", "set to", "poised to"
- "revolutionary", "game-changer", "unprecedented", "major breakthrough"
- "significant", "important" (show with numbers instead)

EXAMPLES:

BEFORE: "Report shows solar installations grew significantly last year"
AFTER: "Global solar installations hit record 593GW in 2024, up 29% year-over-year"

BEFORE: "Company announces progress on offshore wind project"
AFTER: "Orsted resumes 2.6GW Ocean Wind project after 9th Circuit blocks permit freeze"

BEFORE: "Study raises concerns about Amazon deforestation"
AFTER: "Amazon emitted 10-170M tons of carbon in 2023 as extreme drought ravaged rainforest, Max Planck study finds"

BEFORE: "New policy aims to address carbon emissions in the transport sector"
AFTER: "EU tightens truck CO2 standards, requires 45% emissions cut by 2030 and 90% by 2040"

BEFORE: "Bank launches framework to assess biodiversity risks"
AFTER: "BNP Paribas launches country-level biodiversity risk scoring for lending and investment portfolios"

BEFORE: "India's solar manufacturing industry faces oversupply issues, turning a boom into a glut, impacting market stability"
AFTER: "India's solar manufacturing hits oversupply glut as factory capacity outpaces domestic demand"

Output ONLY the rewritten headline — no quotes, no explanation, no preamble.`;
}

function buildLegacyRetrySystemPrompt() {
  return `Today is ${todayLabel()}.

You rewrite climate news headlines. Your previous attempt was too vague.

This time: state EXACTLY what happened, who did it per the source material, and include any specific numbers or names from the source. Do not introduce names, people, or organizations not mentioned in the source. Do not use filler phrases like "aiming to", "impacting", "amid concerns", or "addressing challenges". Every clause must add a concrete fact.

Output ONLY the rewritten headline — no quotes, no explanation, no preamble.`;
}

function buildStructuredSystemPrompt() {
  return `Today is ${todayLabel()}.

TASK
Write a dense, factual, single-line summary of the story in the style of Techmeme. This is not a teaser headline. It should tell the reader the key article finding directly.

CRITICAL RULES
- Lead with the main actor, institution, company, regulator, court, or study named in the source
- State the concrete action, finding, or change
- Include the most important supported number, date, or measurement when it improves the line
- Add attribution for studies, reports, forecasts, earnings guidance, executive statements, and quotes-as-facts: "study finds", "EPA says", "Andy Jassy says", "company estimates"
- Do not use literal quotation marks or verbatim quotes from the article
- Only use names, entities, dates, and numbers present in the source material
- Match certainty to the source: confirmed facts as facts; attributed claims as attributed claims
- Avoid teaser framing, curiosity gaps, and generic topic labels

REWRITE STEPS
1. Identify the main actor or institution.
2. Identify the single most important finding, action, or change.
3. Keep only the highest-value supporting detail, number, or timeframe.
4. Add attribution when the source is a study, report, forecast, or executive statement.
5. Compress into one dense line.

AMBIGUITY
- If the source material is thin, stay conservative and specific.
- If the story is about a study or report, say that.
- If the story is about what a person or company said, attribute it.
- Never ask follow-up questions and never invent missing detail.

OUTPUT FORMAT
- One line only
- No quotes
- No bullet, label, or explanation
- Prefer 140-200 characters; do not exceed 220

EXAMPLE
BEFORE: "Report shows solar installations grew significantly last year"
AFTER: "IEA says global solar installations hit 593GW in 2024, up 29% year-over-year"

Output ONLY the rewritten line — no quotes, no explanation, no preamble.`;
}

function buildStructuredRetrySystemPrompt() {
  return `Today is ${todayLabel()}.

TASK
Your previous single-line summary was too vague, too generic, or missed the main finding.

REWRITE STEPS
1. Lead with the named actor or institution from the source.
2. State the main finding or action directly.
3. Add the strongest supported number, date, or measurement if it helps.
4. Add attribution if the statement is from a study, report, forecast, or executive.
5. Remove teaser phrasing, generic topic labels, and filler.

OUTPUT FORMAT
- One line only
- No quotes
- No labels, bullets, or explanation
- Do not invent names, numbers, or dates

Output ONLY the rewritten line — no quotes, no explanation, no preamble.`;
}

function formatPublishedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function buildUserPrompt(
  input: PromptInput,
  variant: PromptVariant,
): string {
  const lines = [`Original headline: ${input.title}`];

  const pubDate = formatPublishedDate(input.publishedAt);
  if (pubDate) {
    lines.push(`Published: ${pubDate}`);
  }

  if (input.dek) {
    lines.push(`Summary: ${input.dek}`);
  }

  if (input.contentSnippet) {
    lines.push(`Article excerpt: ${input.contentSnippet}`);
  }

  if (input.previewExcerpt) {
    lines.push(`Full article excerpt: ${input.previewExcerpt}`);
  }

  lines.push("");
  lines.push(
    variant === "legacy"
      ? "Rewrite this headline."
      : "Write one dense single-line summary of the story.",
  );

  return lines.join("\n");
}

export function buildSystemPrompt(variant: PromptVariant) {
  return variant === "legacy"
    ? buildLegacySystemPrompt()
    : buildStructuredSystemPrompt();
}

function buildRetrySystemPrompt(variant: PromptVariant) {
  return variant === "legacy"
    ? buildLegacyRetrySystemPrompt()
    : buildStructuredRetrySystemPrompt();
}

export function getEvalProfiles(): EvalProfile[] {
  return DEFAULT_EVAL_PROFILES.map((profile) => ({ ...profile }));
}

function snapshotUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        outputTokenDetails?: { reasoningTokens?: number };
        inputTokenDetails?: { cacheReadTokens?: number };
      }
    | undefined,
): UsageSnapshot | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
  };
}

const NUMERIC_TOKEN_REGEX = /\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent))?/gi;

function normalizeNumericToken(token: string): string | null {
  if (!token) return null;
  let normalized = token.toLowerCase().trim();
  if (!normalized) return null;
  normalized = normalized.replace(/,/g, "");
  normalized = normalized.replace(/percent$/i, "%");
  normalized = normalized.replace(/\s+/g, "");
  normalized = normalized.replace(/[^0-9.%]/g, "");
  normalized = normalized.replace(/\.(?=.*\.)/g, "");
  normalized = normalized.replace(/\.$/, "");
  if (!/\d/.test(normalized)) return null;
  return normalized;
}

function extractNumericTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(NUMERIC_TOKEN_REGEX);
  if (!matches) return [];
  return matches
    .map((token) => normalizeNumericToken(token))
    .filter((token): token is string => Boolean(token));
}

function containsQuantifier(headline: string) {
  return /\d/.test(headline);
}

const CLICKBAIT_PATTERNS = [
  /\bmajor\b.*\bbreakthrough\b/i,
  /\bgame.?chang/i,
  /\brevolutionary\b/i,
  /\bunprecedented\b/i,
  /\bslam/i,
  /\bblast/i,
  /\brip/i,
  /\bwhat to know\b/i,
  /\beverything you need to know\b/i,
  /\bhere'?s\b/i,
  /\bwatch\b/i,
  /\?$/,
];

const WEAK_PATTERNS = [
  /\bmight\b/i,
  /\bpossibly\b/i,
  /\blikely\b/i,
  /\bexpected to\b/i,
  /\bset to\b/i,
  /\bpoised to\b/i,
];

const VAGUE_PATTERNS = [
  /\breports on\b/i,
  /\breports that\b/i,
  /\bcovers\b/i,
  /\bexplores\b/i,
  /\bdiscusses\b/i,
  /\bemphasiz(es|ing)\b/i,
  /\braising concerns\b/i,
  /\braise[sd]? doubts\b/i,
  /\bsparking debate\b/i,
  /\bprompting questions\b/i,
  /\bdrawing attention\b/i,
  /\bciting challenges\b/i,
  /\bciting concerns\b/i,
  /\bciting issues\b/i,
  /\bciting ongoing\b/i,
  /\bbuild(s|ing)? (new )?momentum\b/i,
  /\bgain(s|ing)? traction\b/i,
  /\bmake(s|ing)? progress\b/i,
  /\bhealth implications\b/i,
  /\bbroader implications\b/i,
  /\bongoing research\b/i,
  /\baiming to\b/i,
  /\bimpacting\b/i,
  /\breflecting\b/i,
  /\bamid (concerns|issues|challenges|shifts)\b/i,
  /\bdetailing\b/i,
  /\boutlines?\b/i,
  /\baddressing\b/i,
  /\bfaces? (issues|challenges|concerns)\b/i,
];

const ATTRIBUTION_REQUIRED_SOURCE_PATTERNS = [
  /\b(study|report|survey|analysis|paper|researchers?)\b/i,
  /\b(says|said|according to)\b/i,
  /\b(expects?|projects?|estimates?|forecasts?|guidance)\b/i,
  /\b(ceo|cfo|chair|commissioner|minister|president)\b/i,
];

const ATTRIBUTION_PRESENT_PATTERNS = [
  /\b(says|said|according to)\b/i,
  /\b(study|report|survey|analysis|paper) (finds|found|shows|says)\b/i,
  /\b(researchers?|analysts?) (say|said|find|found)\b/i,
  /\b(estimates?|projects?|expects?|forecasts?|guidance)\b/i,
];

const ATTRIBUTION_TRIGGER_PATTERNS = [
  /\bwill\b/i,
  /\bmay\b/i,
  /\bcould\b/i,
  /\bexpects?\b/i,
  /\bprojects?\b/i,
  /\bestimates?\b/i,
  /\bforecasts?\b/i,
  /\bfinds?\b/i,
];

const WEAK_PRIORITIZATION_PATTERNS = [
  /\b(topic|issue|challenge|trend)\b/i,
  /\bmarket stability\b/i,
  /\bconsumer preferences\b/i,
  /\bindustry dynamics\b/i,
  /\btransition plans\b/i,
];

function failValidation(
  code: RewriteFailureCode,
  message: string,
  preview?: string,
): RewriteValidationResult {
  const suffix = preview ? `: "${preview.slice(0, 60)}..."` : "";
  console.warn(`⚠️  ${message}${suffix}`);
  return { ok: false, code, message };
}

function hasAttribution(text: string) {
  return ATTRIBUTION_PRESENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateDraft(
  original: string,
  draft: string,
  context: ValidationContext,
): RewriteValidationResult {
  if (!draft) {
    return failValidation("empty_output", "Empty rewrite output");
  }

  const t = sanitizeHeadline(draft);
  const { hasContent, sourceQuant } = context;

  const minLength = hasContent ? 60 : 50;
  if (t.length < minLength || t.length > 220) {
    return failValidation(
      "length",
      `Length check failed (${t.length} chars)`,
      t,
    );
  }

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, " ")
      .trim();

  if (!norm(t) || norm(t) === norm(original)) {
    return failValidation("unchanged", "Rewrite unchanged from original", t);
  }

  const draftWords = t.split(/\s+/).length;
  const originalWords = original.split(/\s+/).length;
  const isLikelySocialPost = originalWords > 30;

  if (isLikelySocialPost) {
    if (draftWords < 8) {
      return failValidation(
        "too_short",
        "Rewrite too short for social post condensation",
        t,
      );
    }
  } else if (hasContent) {
    if (draftWords < originalWords * 0.5) {
      return failValidation(
        "too_compressed",
        "Rewrite too compressed despite having content",
        t,
      );
    }
  } else if (draftWords < 6) {
    return failValidation(
      "too_short",
      `Rewrite too short (${draftWords} words)`,
      t,
    );
  }

  const draftNumbers = extractNumericTokens(t);
  if (draftNumbers.length > 0) {
    if (sourceQuant.numbers.size === 0) {
      return failValidation(
        "invented_number",
        `Numeric detail missing in source but present in rewrite: ${draftNumbers.join(", ")}`,
        t,
      );
    }
    const missingNumbers = draftNumbers.filter(
      (num) => !sourceQuant.numbers.has(num),
    );
    if (missingNumbers.length > 0) {
      return failValidation(
        "invented_number",
        `Numeric mismatch: ${missingNumbers.join(", ")} not found in source material`,
        t,
      );
    }
  }

  const politicalFigures = [
    "biden",
    "trump",
    "obama",
    "harris",
    "pence",
    "clinton",
    "desantis",
    "newsom",
    "vance",
  ];
  const srcLower = context.sourceText.toLowerCase();
  const draftLower = t.toLowerCase();
  for (const name of politicalFigures) {
    if (new RegExp(`\\b${name}\\b`).test(draftLower)) {
      if (!new RegExp(`\\b${name}\\b`).test(srcLower)) {
        return failValidation(
          "hallucinated_entity",
          `Hallucinated political figure "${name}" not found in source material`,
          t,
        );
      }
    }
  }

  if (CLICKBAIT_PATTERNS.some((pattern) => pattern.test(t))) {
    return failValidation(
      "teaser_clickbait",
      "Rejected teaser/clickbait language",
      t,
    );
  }

  if (WEAK_PATTERNS.some((pattern) => pattern.test(t))) {
    return failValidation(
      "unsupported_hedging",
      "Rejected weak hedging language",
      t,
    );
  }

  if (VAGUE_PATTERNS.some((pattern) => pattern.test(t))) {
    return failValidation(
      "vague_topic_summary",
      "Rejected vague topic summary",
      t,
    );
  }

  const sourceNeedsAttribution = ATTRIBUTION_REQUIRED_SOURCE_PATTERNS.some(
    (pattern) => pattern.test(context.sourceText),
  );
  const draftNeedsAttribution = ATTRIBUTION_TRIGGER_PATTERNS.some((pattern) =>
    pattern.test(t),
  );
  if (sourceNeedsAttribution && draftNeedsAttribution && !hasAttribution(t)) {
    return failValidation(
      "missing_attribution",
      "Rewrite is missing attribution for a claim, study, or forecast",
      t,
    );
  }

  if (
    hasContent &&
    WEAK_PRIORITIZATION_PATTERNS.some((pattern) => pattern.test(t)) &&
    !containsQuantifier(t) &&
    !hasAttribution(t)
  ) {
    return failValidation(
      "weak_prioritization",
      "Rewrite foregrounds a weak secondary angle instead of the main finding",
      t,
    );
  }

  return { ok: true, code: null, message: null };
}

function buildSourceText(
  row: Row,
  contentSnippet: string | null,
  previewExcerpt: string | null,
) {
  return [
    row.title,
    row.dek,
    contentSnippet,
    previewExcerpt,
    row.content_text,
    row.content_html,
  ]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .join(" ");
}

export async function fetchRewriteCandidates(
  opts: {
    limit?: number;
    pendingOnly?: boolean;
    recentDays?: number;
  } = {},
) {
  const limit = opts.limit ?? 40;
  const recentDays = Math.max(1, Math.floor(opts.recentDays ?? 21));
  const pendingClause =
    opts.pendingOnly === false ? "" : "and a.rewritten_title is null";

  const { rows } = await query<Row>(
    `
      select
        a.id,
        a.title,
        a.dek,
        a.canonical_url,
        a.content_text,
        a.content_html,
        a.content_status,
        a.published_at,
        coalesce(a.publisher_name, s.name) as source_name,
        score_map.score as cluster_score
      from articles a
      left join sources s on s.id = a.source_id
      left join lateral (
        select cs.score
        from cluster_scores cs
        where cs.lead_article_id = a.id
        limit 1
      ) score_map on true
      where 1 = 1
        ${pendingClause}
        and coalesce(a.published_at, now()) > now() - ($2::text || ' days')::interval
        and exists (
          select 1
          from article_categories ac
          where ac.article_id = a.id
        )
        and (
          a.rewrite_notes is null
          or a.rewrite_notes not like 'skipped:not_climate%'
        )
      order by
        score_map.score desc nulls last,
        a.fetched_at desc
      limit $1
    `,
    [limit, String(recentDays)],
  );
  return rows;
}

export function prepareRewriteCandidate(r: Row): PreparedRewriteCandidate {
  const contentSnippet =
    r.content_status === "success"
      ? extractContentSnippet(r.content_text, r.content_html, 1200, r.id)
      : null;

  const previewExcerpt =
    r.content_status === "success" &&
    typeof r.content_html === "string" &&
    r.content_html.trim().length > 0
      ? extractContentSnippet(null, r.content_html, 2500, r.id)
      : null;

  let contentNote = "";
  if (!r.content_status) {
    contentNote = ":no_content";
  } else if (r.content_status !== "success") {
    contentNote = `:${r.content_status}`;
  } else if (!contentSnippet) {
    contentNote = ":content_rejected";
  }

  const sourceQuant = buildSourceQuantContext([
    r.title,
    r.dek,
    contentSnippet,
    previewExcerpt,
    r.content_text,
    r.content_html,
  ]);

  const climateSummaryParts = [
    r.dek,
    contentSnippet,
    previewExcerpt,
    r.content_text,
    r.content_html,
  ].filter(
    (part): part is string =>
      typeof part === "string" && part.trim().length > 0,
  );

  const isClimate = isClimateRelevant({
    title: r.title,
    summary:
      climateSummaryParts.length > 0
        ? climateSummaryParts.join(" ")
        : undefined,
  });

  return {
    row: r,
    promptInput: {
      title: r.title,
      dek: r.dek,
      contentSnippet,
      previewExcerpt,
      publishedAt: r.published_at,
    },
    validationContext: {
      hasContent: !!contentSnippet,
      sourceQuant,
      sourceText: buildSourceText(r, contentSnippet, previewExcerpt),
    },
    contentNote,
    isClimate,
  };
}

async function generateWithProfile(
  input: PromptInput,
  profile: EvalProfile,
  opts: {
    promptVariant?: PromptVariant;
    systemPrompt?: string;
    abortMs?: number;
    retries?: number;
  } = {},
): Promise<GenerationResult> {
  const promptVariant = opts.promptVariant ?? profile.promptVariant;
  const system = opts.systemPrompt ?? buildSystemPrompt(promptVariant);
  const prompt = buildUserPrompt(input, promptVariant);
  const abortMs = opts.abortMs ?? 20000;
  const retries = opts.retries ?? 2;
  const startedAt = Date.now();

  try {
    const model = await resolveModel(profile.provider, profile.modelId);
    const result = await generateText({
      model,
      system,
      prompt,
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      maxRetries: retries,
      abortSignal: AbortSignal.timeout(abortMs),
      providerOptions: profile.providerOptions,
    });

    const notesParts = [
      input.contentSnippet
        ? `with_content:${input.contentSnippet.length}chars`
        : "title_only",
    ];

    if (input.previewExcerpt) {
      notesParts.push(`with_preview:${input.previewExcerpt.length}chars`);
    } else {
      notesParts.push("no_preview");
    }

    return {
      text: sanitizeHeadline(result.text),
      provider: profile.provider,
      modelId: profile.modelId,
      profileId: profile.id,
      promptVariant,
      notes: `success:${profile.id}:${notesParts.join(":")}`,
      usage: snapshotUsage(result.usage),
      latencyMs: Date.now() - startedAt,
      finishReason: result.finishReason,
    };
  } catch (error: unknown) {
    console.error("❌ Error generating text with AI SDK:", error);
    const message = error instanceof Error ? error.message : "unknown_error";
    return {
      text: null,
      provider: profile.provider,
      modelId: profile.modelId,
      profileId: profile.id,
      promptVariant,
      notes: `failed:${profile.id}:${message}`,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export async function executeRewriteProfile(
  prepared: PreparedRewriteCandidate,
  profile: EvalProfile,
): Promise<RewriteExecutionResult> {
  const firstGeneration = await generateWithProfile(
    prepared.promptInput,
    profile,
  );
  const firstDraft = firstGeneration.text || "";
  const firstValidation = validateDraft(
    prepared.row.title,
    firstDraft,
    prepared.validationContext,
  );
  const firstAttempt: RewriteAttempt = {
    retry: false,
    draft: firstDraft,
    validation: firstValidation,
    generation: firstGeneration,
  };

  if (firstValidation.ok) {
    return {
      profile,
      firstAttempt,
      finalAttempt: firstAttempt,
      success: true,
      finalDraft: firstDraft,
    };
  }

  const retryGeneration = await generateWithProfile(
    prepared.promptInput,
    profile,
    {
      promptVariant: profile.retryPromptVariant,
      systemPrompt: buildRetrySystemPrompt(profile.retryPromptVariant),
    },
  );
  const retryDraft = retryGeneration.text || "";
  const retryValidation = validateDraft(
    prepared.row.title,
    retryDraft,
    prepared.validationContext,
  );
  const retryAttempt: RewriteAttempt = {
    retry: true,
    draft: retryDraft,
    validation: retryValidation,
    generation: retryGeneration,
  };

  return {
    profile,
    firstAttempt,
    retryAttempt,
    finalAttempt: retryAttempt,
    success: retryValidation.ok,
    finalDraft: retryValidation.ok ? retryDraft : firstDraft,
  };
}
