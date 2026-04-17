// lib/rewriteShared.ts — Single source of truth for rewrite prompts, validation patterns, and shared utilities.
// Used by both scripts/rewrite.ts (production pipeline) and scripts/rewrite-eval.ts (benchmarking CLI).

import type { PromptVariant } from "@/config/evalProfiles";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PromptInput = {
  title: string;
  dek?: string | null;
  contentSnippet?: string | null;
  previewExcerpt?: string | null;
  publishedAt?: string | null;
};

export type QuantContext = {
  hasQuantEvidence: boolean;
  numbers: Set<string>;
};

export type ValidationContext = {
  hasContent: boolean;
  sourceQuant: QuantContext;
  sourceText: string;
};

/* ------------------------------------------------------------------ */
/*  Date utilities                                                     */
/* ------------------------------------------------------------------ */

export function todayLabel() {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatPublishedDate(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/* ------------------------------------------------------------------ */
/*  Numeric handling                                                   */
/* ------------------------------------------------------------------ */

const QUANTIFIER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
  "trillion",
  "percent",
  "percentage",
];

const QUANTIFIER_REGEXES = QUANTIFIER_WORDS.map(
  (word) => new RegExp(`\\b${word}\\b`, "i"),
);

export function containsQuantifier(headline: string) {
  if (/\d/.test(headline)) return true;
  return QUANTIFIER_REGEXES.some((regex) => regex.test(headline));
}

const NUMBER_WORD_MAP: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
};

const SPELLED_NUMBER_REGEX = new RegExp(
  `\\b(${Object.keys(NUMBER_WORD_MAP).join("|")})\\b`,
  "gi",
);

export const NUMERIC_TOKEN_REGEX = /\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent))?/gi;

export function normalizeNumericToken(token: string): string | null {
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

export function extractNumericTokens(
  text: string | null | undefined,
): string[] {
  if (!text) return [];
  const matches = text.match(NUMERIC_TOKEN_REGEX);
  if (!matches) return [];
  return matches
    .map((token) => normalizeNumericToken(token))
    .filter((token): token is string => Boolean(token));
}

function extractSpelledNumberTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  SPELLED_NUMBER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPELLED_NUMBER_REGEX.exec(text)) !== null) {
    const mapped = NUMBER_WORD_MAP[match[1].toLowerCase()];
    if (mapped) tokens.push(mapped);
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/*  Content extraction & sanitization                                  */
/* ------------------------------------------------------------------ */

/**
 * Extract a meaningful snippet from article content with comprehensive safety checks.
 * Prioritizes first few paragraphs (the lede) while filtering out paywalls and garbage.
 */
export function extractContentSnippet(
  contentText: string | null,
  contentHtml: string | null,
  maxChars = 600,
  articleId?: number,
): string | null {
  const text = contentText || contentHtml;
  if (!text) return null;

  // Strip HTML tags if present
  let cleaned = text.replace(/<[^>]+>/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  const idLabel = articleId ? `[${articleId}] ` : "";
  if (cleaned.length < 100) {
    console.warn(`⚠️  ${idLabel}Content too short (<100 chars), skipping`);
    return null;
  }

  // Detect paywall language (require 2+ distinct matches to avoid false positives)
  const paywallPatterns = [
    /subscribe/i,
    /subscription/i,
    /sign in/i,
    /member/i,
    /premium/i,
    /paywall/i,
  ];
  const firstPart = cleaned.slice(0, 200);
  const paywallMatches = paywallPatterns.filter((p) => p.test(firstPart));
  if (paywallMatches.length >= 2) {
    console.warn(
      `⚠️  ${idLabel}Paywall detected (${paywallMatches.length} signals): "${firstPart.slice(0, 80)}..."`,
    );
    return null;
  }

  // Word count sanity
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 30) {
    console.warn(`⚠️  ${idLabel}Content too few words (<30), skipping`);
    return null;
  }

  // Uniqueness ratio (detect repetitive error pages)
  const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
  if (uniqueWords.size < words.length * 0.3) {
    console.warn(`⚠️  ${idLabel}Content too repetitive, skipping`);
    return null;
  }

  // Extract first few sentences (usually the lead)
  const sentences = cleaned.split(/[.!?]+\s+/);
  let snippet = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 10) continue;

    if (snippet.length + trimmed.length > maxChars) break;
    snippet += (snippet ? " " : "") + trimmed + ".";
  }

  return snippet.length >= 50 ? snippet : null;
}

export function sanitizeHeadline(s: string) {
  let t = (s || "")
    .replace(/^[""'\s]+|[""'\s]+$/g, "") // strip quotes
    .replace(/\s+/g, " ") // collapse spaces
    .trim();
  // Remove trailing periods and other decorative punctuation
  t = t.replace(/[-.|•–—]+$/g, "").trim();
  return t;
}

export function buildSourceQuantContext(
  parts: Array<string | null | undefined>,
): QuantContext {
  const filtered = parts.filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  if (filtered.length === 0) {
    return { hasQuantEvidence: false, numbers: new Set() };
  }
  const MAX_SEGMENT_LENGTH = 12000;
  const combined = filtered
    .map((segment) =>
      segment.length > MAX_SEGMENT_LENGTH
        ? segment.slice(0, MAX_SEGMENT_LENGTH)
        : segment,
    )
    .join(" ");
  const numbers = new Set([
    ...extractNumericTokens(combined),
    ...extractSpelledNumberTokens(combined),
  ]);
  return {
    hasQuantEvidence: containsQuantifier(combined),
    numbers,
  };
}

/* ------------------------------------------------------------------ */
/*  Validation patterns                                                */
/* ------------------------------------------------------------------ */

export const POLITICAL_FIGURES = [
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

export const CLICKBAIT_PATTERNS = [
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

export const WEAK_PATTERNS = [
  /\bmight\b/i,
  /\bpossibly\b/i,
  /\blikely\b/i,
  /\bexpected to\b/i,
  /\bset to\b/i,
  /\bpoised to\b/i,
];

export const VAGUE_PATTERNS = [
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

export const ATTRIBUTION_REQUIRED_SOURCE_PATTERNS = [
  /\b(study|report|survey|analysis|paper|researchers?)\b/i,
  /\b(says|said|according to)\b/i,
  /\b(expects?|projects?|estimates?|forecasts?|guidance)\b/i,
  /\b(ceo|cfo|chair|commissioner|minister|president)\b/i,
];

export const ATTRIBUTION_PRESENT_PATTERNS = [
  /\b(says|said|according to)\b/i,
  /\b(study|report|survey|analysis|paper) (finds|found|shows|says)\b/i,
  /\b(researchers?|analysts?) (say|said|find|found)\b/i,
  /\b(estimates?|projects?|expects?|forecasts?|guidance)\b/i,
];

export const ATTRIBUTION_TRIGGER_PATTERNS = [
  /\bwill\b/i,
  /\bmay\b/i,
  /\bcould\b/i,
  /\bexpects?\b/i,
  /\bprojects?\b/i,
  /\bestimates?\b/i,
  /\bforecasts?\b/i,
  /\bfinds?\b/i,
];

export function hasAttribution(text: string) {
  return ATTRIBUTION_PRESENT_PATTERNS.some((pattern) => pattern.test(text));
}

export const WEAK_PRIORITIZATION_PATTERNS = [
  /\b(topic|issue|challenge|trend)\b/i,
  /\bmarket stability\b/i,
  /\bconsumer preferences\b/i,
  /\bindustry dynamics\b/i,
  /\btransition plans\b/i,
];

/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */

function buildLegacySystemPrompt() {
  return `Today is ${todayLabel()}.

You rewrite climate news headlines in the style of Techmeme: dense, factual, scannable.

RULES:
- Lead with WHO (named entity from the source: "EPA", "Ørsted", "9th Circuit") + strong action verb
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
AFTER: "Ørsted resumes 2.6GW Ocean Wind project after 9th Circuit blocks permit freeze"

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

export function buildSystemPrompt(variant: PromptVariant) {
  return variant === "legacy"
    ? buildLegacySystemPrompt()
    : buildStructuredSystemPrompt();
}

export function buildRetrySystemPrompt(variant: PromptVariant) {
  return variant === "legacy"
    ? buildLegacyRetrySystemPrompt()
    : buildStructuredRetrySystemPrompt();
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
