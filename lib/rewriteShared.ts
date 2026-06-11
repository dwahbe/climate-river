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

/** A number with its (normalized) unit, value already scaled by any magnitude word. */
export type Measurement = { value: number; unit: string };

export type QuantContext = {
  hasQuantEvidence: boolean;
  numbers: Set<string>;
  /** Unit/magnitude-aware figures, used to catch scale/unit hallucinations. */
  measurements: Measurement[];
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
/*  Unit/magnitude-aware measurements (hallucination + rounding guard) */
/* ------------------------------------------------------------------ */

const MAGNITUDE_WORDS: Record<string, number> = {
  hundred: 1e2,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};

// Short magnitude abbreviations — only honored when a currency symbol is
// present (e.g. "$5B"), to avoid mis-scaling unit letters like the "M" in "MW".
const MAGNITUDE_ABBR: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  bn: 1e9,
  b: 1e9,
  tn: 1e12,
};

// Recognized units, normalized to a canonical token. Distinct from magnitudes.
// Both abbreviated and spelled-out forms map to the same canonical token so a
// rewrite that spells the unit differently from the source still validates
// ("2.6 GW" ↔ "2.6 gigawatts").
const UNIT_ALIASES: Record<string, string> = {
  "%": "%",
  percent: "%",
  gw: "gw",
  gigawatt: "gw",
  gigawatts: "gw",
  mw: "mw",
  megawatt: "mw",
  megawatts: "mw",
  kw: "kw",
  kilowatt: "kw",
  kilowatts: "kw",
  tw: "tw",
  terawatt: "tw",
  terawatts: "tw",
  gwh: "gwh",
  mwh: "mwh",
  kwh: "kwh",
  twh: "twh",
  ton: "ton",
  tons: "ton",
  tonne: "ton",
  tonnes: "ton",
  kt: "kt",
  kilotonne: "kt",
  kilotonnes: "kt",
  mt: "mt",
  megatonne: "mt",
  megatonnes: "mt",
  gt: "gt",
  gigatonne: "gt",
  gigatonnes: "gt",
};

const MEASUREMENT_REGEX = /([$€£])?\s?(\d[\d,]*(?:\.\d+)?)\s*([a-z%]+)?/gi;

/**
 * Parse figures into {value, unit} pairs, scaling by magnitude words and
 * normalizing units. Lets the validator distinguish "$5 million" from
 * "$5 billion" and "593 GW" from "593 million tons" — swaps the old
 * digits-only normalizer silently accepted.
 */
export function parseMeasurements(
  text: string | null | undefined,
): Measurement[] {
  if (!text) return [];
  const out: Measurement[] = [];
  MEASUREMENT_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEASUREMENT_REGEX.exec(text)) !== null) {
    const currency = m[1] ? "$" : null; // normalize any currency symbol to "$"
    const value0 = Number.parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value0)) continue;
    const suffix = (m[3] || "").toLowerCase();

    let value = value0;
    let unit = currency ?? "";
    if (suffix in MAGNITUDE_WORDS) {
      value *= MAGNITUDE_WORDS[suffix];
    } else if (currency && suffix in MAGNITUDE_ABBR) {
      value *= MAGNITUDE_ABBR[suffix];
    } else if (suffix in UNIT_ALIASES) {
      unit = UNIT_ALIASES[suffix];
    }
    // Unknown suffix (a stray word) → bare/currency value only.
    out.push({ value, unit });
  }
  return out;
}

/** True if two numbers are equal or within ~3% — i.e. faithful rounding, not a swap. */
export function numbersClose(a: number, b: number): boolean {
  if (a === b) return true;
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (hi === 0) return true;
  return Math.abs(a - b) / hi <= 0.03;
}

/**
 * Whether a draft measurement is supported by a source measurement.
 * - Two distinct REAL units never match (gw ≠ ton, % ≠ $).
 * - Two BARE unitless figures (years, plain counts) must match EXACTLY —
 *   rounding tolerance must NOT apply, or "by 2050" would validate "by 2030"
 *   and "40 plants" would validate "41 plants".
 * - Otherwise (a measured unit is involved: %, $, GW, tons, …) rounding
 *   tolerance applies (28.7% ≈ 29%, $1.17B ≈ $1.2B). A bare figure is treated
 *   as compatible with a unit-qualified one of the same magnitude so faithful
 *   rewrites like "5 billion" ↔ "$5 billion" still validate.
 */
export function measurementsMatch(a: Measurement, b: Measurement): boolean {
  if (a.unit && b.unit && a.unit !== b.unit) return false;
  if (!a.unit && !b.unit) return a.value === b.value;
  return numbersClose(a.value, b.value);
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
    return { hasQuantEvidence: false, numbers: new Set(), measurements: [] };
  }
  const MAX_SEGMENT_LENGTH = 12000;
  const combined = filtered
    .map((segment) =>
      segment.length > MAX_SEGMENT_LENGTH
        ? segment.slice(0, MAX_SEGMENT_LENGTH)
        : segment,
    )
    .join(" ");
  const spelled = extractSpelledNumberTokens(combined);
  const numbers = new Set([...extractNumericTokens(combined), ...spelled]);
  const measurements: Measurement[] = [
    ...parseMeasurements(combined),
    ...spelled.map(
      (token): Measurement => ({ value: Number(token), unit: "" }),
    ),
  ];
  return {
    hasQuantEvidence: containsQuantifier(combined),
    numbers,
    measurements,
  };
}

/* ------------------------------------------------------------------ */
/*  Validation patterns                                                */
/* ------------------------------------------------------------------ */

// Named figures cross-checked against the source: if one appears in the draft
// headline but NOT in the source material, the rewrite is rejected as a
// hallucinated attribution. Purely additive — adding names only catches more
// fabrications (it never fires when the model faithfully uses a name from the
// source), so it carries no false-positive risk. Kept to distinctive surnames /
// full names to avoid matching common words used non-referentially.
export const POLITICAL_FIGURES = [
  // US
  "biden",
  "trump",
  "obama",
  "harris",
  "pence",
  "clinton",
  "desantis",
  "newsom",
  "vance",
  "zeldin", // EPA administrator
  "granholm", // former energy secretary
  "john kerry", // former climate envoy
  "al gore",
  // World leaders / officials frequently in climate coverage
  "modi",
  "xi jinping",
  "putin",
  "macron",
  "scholz",
  "merz",
  "starmer",
  "sunak",
  "meloni",
  "von der leyen",
  "lula",
  "milei",
  "sheinbaum",
  "trudeau",
  "carney",
  "albanese",
  "erdogan",
  "netanyahu",
  "zelensky",
  "zelenskyy",
  "guterres", // UN Secretary-General
  // Climate movement
  "thunberg",
];

export const CLICKBAIT_PATTERNS = [
  /\bmajor\b.*\bbreakthrough\b/i,
  /\bgame.?chang/i,
  /\brevolutionary\b/i,
  /\bunprecedented\b/i,
  /\bslam/i,
  /\bblast/i,
  /\brips?\b/i,
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

// "challenge" is weak filler ("faces challenges") but core news vocabulary in
// legal/political contexts ("files legal challenge to EPA rule"). When these
// concrete uses are present, the weak-prioritization check should not fire.
export const PRIORITIZATION_EXCEPTIONS = [
  /\b(legal|court|constitutional|supreme court|judicial) challenge\b/i,
  /\bchalleng(es|ed|ing)\b.*\b(rule|ruling|law|permit|order|ban|decision|policy|in court)\b/i,
];

// The model sometimes emits a refusal/meta sentence AS the headline (e.g. "No
// climate or energy entity action found in source; headline not applicable for
// rewriting"). These must never be published.
export const META_REFUSAL_PATTERNS = [
  /\bnot applicable\b/i,
  /\bno (climate|energy|relevant)\b.*\b(found|detected|action)\b/i,
  /\b(cannot|can'?t|unable to) (rewrite|generate|produce)\b/i,
  /\bheadline (not|cannot)\b/i,
  /\bno (valid )?headline\b/i,
  /\binsufficient (information|content|context)\b/i,
  /\bas an ai\b/i,
];

const ENTITY_STOPWORDS = new Set([
  "The",
  "A",
  "An",
  "In",
  "On",
  "At",
  "For",
  "To",
  "Of",
  "And",
  "But",
  "Or",
  "As",
  "By",
  "With",
  "After",
  "Before",
  "Amid",
  "Over",
  "New",
  "US",
  "U.S.",
  "UK",
  "EU",
  "UN",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

/**
 * Find multi-word proper-noun entities in the draft (2+ consecutive capitalized
 * words, e.g. "Mountain Valley Pipeline", "European Investment Bank") whose
 * words are ENTIRELY absent from the source text — a strong hallucination
 * signal. Conservative by design: single-word names, acronyms, and any entity
 * sharing even one token with the source are allowed, so faithful abbreviation
 * (source "EU" → draft "European Union") and partial reuse are not flagged.
 */
export function findUnsupportedEntities(
  draft: string,
  sourceText: string,
): string[] {
  const srcLower = sourceText.toLowerCase();
  const unsupported: string[] = [];
  // Sequences of 2+ capitalized words (allowing internal lowercase connectors
  // like "of"/"and" is intentionally NOT done — keep it simple and strict).
  const phraseRe = /\b([A-Z][a-zA-Z.&'-]+(?:\s+[A-Z][a-zA-Z.&'-]+)+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(draft)) !== null) {
    const phrase = m[1];
    const words = phrase
      .split(/\s+/)
      .filter((w) => !ENTITY_STOPWORDS.has(w) && w.length > 2);
    if (words.length < 2) continue;
    // Supported if ANY significant word appears in the source.
    const anyInSource = words.some((w) =>
      srcLower.includes(w.toLowerCase().replace(/[.,;:'"-]+$/, "")),
    );
    if (!anyInSource) unsupported.push(phrase);
  }
  return unsupported;
}

/* ------------------------------------------------------------------ */
/*  Headline validator (single source of truth — imported by both the  */
/*  production rewrite script and the eval harness so they measure the  */
/*  same gate)                                                          */
/* ------------------------------------------------------------------ */

export type HeadlineFailureReason =
  | "empty"
  | "length"
  | "truncated"
  | "meta_refusal"
  | "unchanged"
  | "too_short_social"
  | "too_compressed"
  | "too_short_no_content"
  | "numeric_missing_in_source"
  | "numeric_mismatch"
  | "hallucinated_political_figure"
  | "hallucinated_entity"
  | "clickbait"
  | "weak_hedging"
  | "vague_meta_reporting"
  | "missing_attribution"
  | "weak_prioritization"
  | "llm_error";

export type HeadlineCheck =
  | { ok: true; reason: null }
  | { ok: false; reason: HeadlineFailureReason };

/**
 * Structured validator for rewritten headlines. Returns a stable failure
 * `reason` identifier so per-attempt telemetry (rewrite_attempts) can break
 * down rejections by failure mode.
 */
export function validateHeadline(
  original: string,
  draft: string,
  context: ValidationContext,
): HeadlineCheck {
  if (!draft) return { ok: false, reason: "empty" };
  const t = sanitizeHeadline(draft);
  const { hasContent, sourceQuant } = context;

  const minLength = hasContent ? 60 : 50;
  if (t.length < minLength || t.length > 220) {
    console.warn(
      `⚠️  Length check failed (${t.length} chars): "${t.slice(0, 50)}..."`,
    );
    return { ok: false, reason: "length" };
  }

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, " ")
      .trim();

  if (!norm(t) || norm(t) === norm(original)) {
    console.warn(`⚠️  Headline unchanged from original`);
    return { ok: false, reason: "unchanged" };
  }

  // Reject refusal/meta sentences emitted as the headline (e.g. "No climate
  // entity action found in source; headline not applicable for rewriting").
  if (META_REFUSAL_PATTERNS.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected meta/refusal output: "${t.slice(0, 60)}..."`);
    return { ok: false, reason: "meta_refusal" };
  }

  const draftWords = t.split(/\s+/).length;
  const originalWords = original.split(/\s+/).length;
  const isLikelySocialPost = originalWords > 30;

  if (isLikelySocialPost) {
    if (draftWords < 8) {
      console.warn(`⚠️  Headline too short for social post condensation`);
      return { ok: false, reason: "too_short_social" };
    }
  } else if (hasContent) {
    if (draftWords < originalWords * 0.5) {
      console.warn(`⚠️  Headline too compressed despite having content`);
      return { ok: false, reason: "too_compressed" };
    }
  } else {
    if (draftWords < 6) {
      console.warn(`⚠️  Headline too short (${draftWords} words)`);
      return { ok: false, reason: "too_short_no_content" };
    }
  }

  const draftMeasurements = parseMeasurements(t);
  if (draftMeasurements.length > 0) {
    const sourceMeasurements = sourceQuant.measurements;
    if (sourceMeasurements.length === 0) {
      console.warn(
        `⚠️  Numeric detail missing in source but present in rewrite: ${draftMeasurements
          .map((m) => `${m.value}${m.unit}`)
          .join(", ")}`,
      );
      return { ok: false, reason: "numeric_missing_in_source" };
    }
    // Unit/magnitude-aware match with rounding tolerance: rejects scale/unit
    // swaps ("$5M"→"$5B", "593 GW"→"593 million tons") while accepting faithful
    // rounding ("28.7%"→"29%").
    const unmatched = draftMeasurements.filter(
      (dm) => !sourceMeasurements.some((sm) => measurementsMatch(dm, sm)),
    );
    if (unmatched.length > 0) {
      console.warn(
        `⚠️  Numeric mismatch: ${unmatched
          .map((m) => `${m.value}${m.unit}`)
          .join(", ")} not supported by source material`,
      );
      return { ok: false, reason: "numeric_mismatch" };
    }
  }

  const srcLower = context.sourceText.toLowerCase();
  const draftLower = t.toLowerCase();
  for (const name of POLITICAL_FIGURES) {
    if (new RegExp(`\\b${name}\\b`).test(draftLower)) {
      if (!new RegExp(`\\b${name}\\b`).test(srcLower)) {
        console.warn(
          `⚠️  Hallucinated political figure "${name}" not found in source material: "${t.slice(0, 60)}..."`,
        );
        return { ok: false, reason: "hallucinated_political_figure" };
      }
    }
  }

  // Multi-word proper-noun entities wholly absent from the source are a strong
  // hallucination signal. Only enforced when we have real content to check
  // against — with title+dek only, legitimate entities often aren't repeated.
  if (hasContent) {
    const unsupported = findUnsupportedEntities(t, context.sourceText);
    if (unsupported.length > 0) {
      console.warn(
        `⚠️  Unsupported entity ${JSON.stringify(unsupported[0])} not in source: "${t.slice(0, 60)}..."`,
      );
      return { ok: false, reason: "hallucinated_entity" };
    }
  }

  if (CLICKBAIT_PATTERNS.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected vague/hype language: "${t.slice(0, 50)}..."`);
    return { ok: false, reason: "clickbait" };
  }

  if (WEAK_PATTERNS.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected weak hedging language: "${t.slice(0, 50)}..."`);
    return { ok: false, reason: "weak_hedging" };
  }

  // Vague/meta-reporting filler is only a problem when the line is ALSO
  // unquantified; a concrete number rescues headlines like
  // "EPA rule covers 40% of US power plants". (hasAttribution is intentionally
  // NOT used here: its /\bprojects?\b/ pattern matches the common noun
  // "project", which would wrongly exempt vague headlines.)
  if (VAGUE_PATTERNS.some((p) => p.test(t)) && !containsQuantifier(t)) {
    console.warn(
      `⚠️  Rejected vague/meta-reporting pattern: "${t.slice(0, 50)}..."`,
    );
    return { ok: false, reason: "vague_meta_reporting" };
  }

  const sourceNeedsAttribution = ATTRIBUTION_REQUIRED_SOURCE_PATTERNS.some(
    (p) => p.test(context.sourceText),
  );
  const draftNeedsAttribution = ATTRIBUTION_TRIGGER_PATTERNS.some((p) =>
    p.test(t),
  );
  if (sourceNeedsAttribution && draftNeedsAttribution && !hasAttribution(t)) {
    console.warn(`⚠️  Rejected missing attribution: "${t.slice(0, 50)}..."`);
    return { ok: false, reason: "missing_attribution" };
  }

  if (
    hasContent &&
    WEAK_PRIORITIZATION_PATTERNS.some((p) => p.test(t)) &&
    !PRIORITIZATION_EXCEPTIONS.some((p) => p.test(t)) &&
    !containsQuantifier(t) &&
    !hasAttribution(t)
  ) {
    console.warn(`⚠️  Rejected weak prioritization: "${t.slice(0, 50)}..."`);
    return { ok: false, reason: "weak_prioritization" };
  }

  return { ok: true, reason: null };
}

/**
 * Backwards-compatible boolean wrapper around {@link validateHeadline}.
 */
export function passesChecks(
  original: string,
  draft: string,
  context: ValidationContext,
): boolean {
  return validateHeadline(original, draft, context).ok;
}

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
- Never phrase the headline as a question; state the finding directly

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
