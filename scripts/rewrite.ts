// scripts/rewrite.ts
import { query, endPool } from "@/lib/db";
import { isClimateRelevant } from "@/lib/tagger";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

type Row = {
  id: number;
  title: string;
  dek: string | null;
  canonical_url: string;
  content_text: string | null;
  content_html: string | null;
  content_status: string | null;
};

/* ------------------------- Content Extraction with Safety Checks ------------------------- */

/**
 * Extract a meaningful snippet from article content with comprehensive safety checks
 * Prioritizes first few paragraphs (the lede) while filtering out paywalls and garbage
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
  let cleaned = text.replace(/<[^>]+>/g, " "); // TODO: Use a HTML parser to strip tags
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // 🛡️ SAFETY CHECK 1: Minimum viable length
  const idLabel = articleId ? `[${articleId}] ` : "";
  if (cleaned.length < 100) {
    console.warn(`⚠️  ${idLabel}Content too short (<100 chars), skipping`);
    return null;
  }

  // 🛡️ SAFETY CHECK 2: Detect paywall language (require 2+ distinct matches
  // to avoid false positives from words like "premium" or "member" in articles)
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

  // 🛡️ SAFETY CHECK 3: Word count sanity
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 30) {
    console.warn(`⚠️  ${idLabel}Content too few words (<30), skipping`);
    return null;
  }

  // 🛡️ SAFETY CHECK 4: Uniqueness ratio (detect repetitive error pages)
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
    if (trimmed.length < 10) continue; // Skip tiny fragments

    if (snippet.length + trimmed.length > maxChars) break;
    snippet += (snippet ? " " : "") + trimmed + ".";
  }

  // Final validation
  return snippet.length >= 50 ? snippet : null;
}

/* ------------------------- Techmeme-Style Prompt ------------------------- */

const SYSTEM_PROMPT = `You rewrite climate news headlines in the style of Techmeme: dense, factual, scannable.

RULES:
- Lead with WHO (named entity: "EPA", "Ørsted", "9th Circuit") + strong action verb
- Present tense, active voice, no period at end
- 140-200 characters ideal; use commas and semicolons to pack detail
- Only include numbers/dates/measurements that appear in the source material
- If no numbers exist, stay concrete and qualitative — never pad with filler
- Name specific entities, policies, products — never "regulators", "a company", "a bank"
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

const RETRY_SYSTEM_PROMPT = `You rewrite climate news headlines. Your previous attempt was too vague.

This time: state EXACTLY what happened, who did it, and include any specific numbers or names from the source material. Do not use filler phrases like "aiming to", "impacting", "amid concerns", or "addressing challenges". Every clause must add a concrete fact.

Output ONLY the rewritten headline — no quotes, no explanation, no preamble.`;

type PromptInput = {
  title: string;
  dek?: string | null;
  contentSnippet?: string | null;
  previewExcerpt?: string | null;
};

function buildUserPrompt(input: PromptInput) {
  const lines = [`Original headline: ${input.title}`];

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
  lines.push("Rewrite this headline.");

  return lines.join("\n");
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

function containsQuantifier(headline: string) {
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

type QuantContext = {
  hasQuantEvidence: boolean;
  numbers: Set<string>;
};

type ValidationContext = {
  hasContent: boolean;
  sourceQuant: QuantContext;
};

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

/* ------------------------- Enhanced Validation ------------------------- */

export function passesChecks(
  original: string,
  draft: string,
  context: ValidationContext,
) {
  if (!draft) return false;
  const t = sanitizeHeadline(draft);
  const { hasContent, sourceQuant } = context;

  const minLength = hasContent ? 60 : 50;
  if (t.length < minLength || t.length > 220) {
    console.warn(
      `⚠️  Length check failed (${t.length} chars): "${t.slice(0, 50)}..."`,
    );
    return false;
  }

  // Note: Removed "require quantifier if headline has numbers" check
  // Rationale: Hallucination check still catches invented numbers,
  // and LLM may intentionally omit numbers that aren't central to the story

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, " ")
      .trim();

  // Must be different from original
  if (!norm(t) || norm(t) === norm(original)) {
    console.warn(`⚠️  Headline unchanged from original`);
    return false;
  }

  const draftWords = t.split(/\s+/).length;
  const originalWords = original.split(/\s+/).length;
  const isLikelySocialPost = originalWords > 30;

  if (isLikelySocialPost) {
    if (draftWords < 8) {
      console.warn(`⚠️  Headline too short for social post condensation`);
      return false;
    }
  } else if (hasContent) {
    if (draftWords < originalWords * 0.5) {
      console.warn(`⚠️  Headline too compressed despite having content`);
      return false;
    }
  } else {
    if (draftWords < 6) {
      console.warn(`⚠️  Headline too short (${draftWords} words)`);
      return false;
    }
  }

  // Ensure numeric claims exist in source material
  const draftNumbers = extractNumericTokens(t);
  if (draftNumbers.length > 0) {
    if (sourceQuant.numbers.size === 0) {
      console.warn(
        `⚠️  Numeric detail missing in source but present in rewrite: ${draftNumbers.join(
          ", ",
        )}`,
      );
      return false;
    }
    const missingNumbers = draftNumbers.filter(
      (num) => !sourceQuant.numbers.has(num),
    );
    if (missingNumbers.length > 0) {
      console.warn(
        `⚠️  Numeric mismatch: ${missingNumbers.join(
          ", ",
        )} not found in source material`,
      );
      return false;
    }
  }

  // Check for vague/hype phrases that shouldn't be in good headlines
  const badPatterns = [
    /\bmajor\b.*\bbreakthrough\b/i,
    /\bgame.?chang/i,
    /\brevolutionary\b/i,
    /\bunprecedented\b/i,
    /\bslam/i, // "X slams Y" - too casual
    /\bblast/i, // "X blasts Y" - too tabloid
    /\brip/i, // "X rips Y" - too informal
  ];

  if (badPatterns.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected vague/hype language: "${t.slice(0, 50)}..."`);
    return false;
  }

  // Check for weak hedging language (allow "could"/"may" for scientific projections)
  // Reject hedging words that soften confirmed facts
  const weakPatterns = [
    /\bmight\b/i,
    /\bpossibly\b/i,
    /\blikely\b/i,
    /\bexpected to\b/i,
    /\bset to\b/i,
    /\bpoised to\b/i,
  ];

  if (weakPatterns.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected weak hedging language: "${t.slice(0, 50)}..."`);
    return false;
  }

  // Check for vague/meta-reporting patterns that produce headlines about articles, not news
  const vaguePatterns = [
    // Meta-reporting (headline about article, not news)
    /\breports on\b/i,
    /\breports that\b/i,
    /\bcovers\b/i,
    /\bexplores\b/i,
    /\bdiscusses\b/i,
    /\bemphasiz(es|ing)\b/i,

    // Vague concern/debate language
    /\braising concerns\b/i,
    /\braise[sd]? doubts\b/i,
    /\bsparking debate\b/i,
    /\bprompting questions\b/i,
    /\bdrawing attention\b/i,

    // Empty citations
    /\bciting challenges\b/i,
    /\bciting concerns\b/i,
    /\bciting issues\b/i,
    /\bciting ongoing\b/i,

    // Hollow momentum phrases
    /\bbuild(s|ing)? (new )?momentum\b/i,
    /\bgain(s|ing)? traction\b/i,
    /\bmake(s|ing)? progress\b/i,

    // Generic implications
    /\bhealth implications\b/i,
    /\bbroader implications\b/i,
    /\bongoing research\b/i,

    // Vague filler clauses (pad headlines without adding info)
    /\baiming to\b/i,
    /\bimpacting\b/i,
    /\breflecting\b/i,
    /\bamid (concerns|issues|challenges|shifts)\b/i,
    /\bdetailing\b/i,
    /\boutlines?\b/i,
    /\baddressing\b/i,
    /\bfaces? (issues|challenges|concerns)\b/i,
  ];

  if (vaguePatterns.some((p) => p.test(t))) {
    console.warn(
      `⚠️  Rejected vague/meta-reporting pattern: "${t.slice(0, 50)}..."`,
    );
    return false;
  }

  // Note: Removed output headline climate term check
  // Articles already passed isClimateRelevant() during categorization AND rewrite input
  // The LLM naturally produces climate-relevant headlines from climate content
  // Removing this check prevents false negatives like "Heat Pumps Prevail..." or "EU ETS reform..."

  return true;
}

/* ------------------------- LLM Generation ------------------------- */

async function generateWithOpenAI(
  input: PromptInput,
  opts: {
    systemPrompt?: string;
    abortMs?: number;
    retries?: number;
  } = {},
): Promise<{ text: string | null; model: string; notes: string }> {
  const system = opts.systemPrompt ?? SYSTEM_PROMPT;
  const prompt = buildUserPrompt(input);
  const abortMs = opts.abortMs ?? 20000;
  const retries = opts.retries ?? 2;
  const model = "gpt-4.1-mini";

  try {
    const { text } = await generateText({
      model: openai(model),
      system,
      prompt,
      temperature: 0.15,
      maxOutputTokens: 80,
      maxRetries: retries,
      abortSignal: AbortSignal.timeout(abortMs),
    });

    const sanitized = sanitizeHeadline(text);
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
      text: sanitized,
      model,
      notes: `success:${notesParts.join(":")}`,
    };
  } catch (error: unknown) {
    console.error("❌ Error generating text with AI SDK:", error);
    const message = error instanceof Error ? error.message : "unknown_error";
    return {
      text: null,
      model,
      notes: `failed:${message}`,
    };
  }
}

/* ------------------------------- Runner -------------------------------- */

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
) {
  const ret: R[] = new Array(items.length);
  let i = 0;
  let active = 0;
  return new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(ret);
      while (active < limit && i < items.length) {
        const cur = i++;
        active++;
        fn(items[cur], cur)
          .then((v) => (ret[cur] = v))
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

async function fetchBatch(limit = 40) {
  const { rows } = await query<Row>(
    `
      select 
        a.id, 
        a.title, 
        a.dek, 
        a.canonical_url,
        a.content_text,
        a.content_html,
        a.content_status
      from articles a
      left join lateral (
        select cs.score
        from cluster_scores cs
        where cs.lead_article_id = a.id
        limit 1
      ) score_map on true
      where a.rewritten_title is null
        and coalesce(a.published_at, now()) > now() - interval '21 days'
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
    [limit],
  );
  return rows;
}

async function processOne(r: Row) {
  // SAFETY LAYER 1: Only use content if status is explicitly 'success'
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

  // Track what happened with content
  let contentNote = "";
  if (!r.content_status) {
    contentNote = ":no_content";
  } else if (r.content_status !== "success") {
    contentNote = `:${r.content_status}`; // :paywall, :blocked, :timeout, etc.
  } else if (!contentSnippet) {
    contentNote = ":content_rejected"; // Had content but failed quality checks
  }

  // For validating numbers exist: check only this article's own content
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

  if (!isClimate) {
    const notes = "skipped:not_climate";
    await query(
      `update articles
         set rewrite_model = $1,
             rewrite_notes = $2
       where id = $3`,
      ["skipped", notes, r.id],
    );
    console.log(
      `🚫 [${r.id}] Skipped rewrite (non-climate detected): "${r.title.slice(
        0,
        80,
      )}..."`,
    );
    return { ok: 0, failed: 1 };
  }

  const promptInput: PromptInput = {
    title: r.title,
    dek: r.dek,
    contentSnippet,
    previewExcerpt,
  };

  const validationContext: ValidationContext = {
    hasContent: !!contentSnippet,
    sourceQuant,
  };

  // First attempt
  const llm = await generateWithOpenAI(promptInput);
  const draft = llm.text || "";

  if (passesChecks(r.title, draft, validationContext)) {
    const notes = llm.notes + contentNote;
    await query(
      `update articles
         set rewritten_title = $1,
             rewritten_at   = now(),
             rewrite_model  = $2,
             rewrite_notes  = $3
       where id = $4`,
      [draft, llm.model || "unknown", notes, r.id],
    );
    console.log(
      `✅ [${r.id}] "${r.title.slice(0, 40)}..." → "${draft.slice(0, 60)}..."`,
    );
    return { ok: 1, failed: 0 };
  }

  // Retry once with a more direct prompt
  const retryLlm = await generateWithOpenAI(promptInput, {
    systemPrompt: RETRY_SYSTEM_PROMPT,
  });
  const retryDraft = retryLlm.text || "";

  if (passesChecks(r.title, retryDraft, validationContext)) {
    const notes = retryLlm.notes.replace("success:", "success:retry:") + contentNote;
    await query(
      `update articles
         set rewritten_title = $1,
             rewritten_at   = now(),
             rewrite_model  = $2,
             rewrite_notes  = $3
       where id = $4`,
      [retryDraft, retryLlm.model || "unknown", notes, r.id],
    );
    console.log(
      `✅ [${r.id}] (retry) "${r.title.slice(0, 40)}..." → "${retryDraft.slice(0, 60)}..."`,
    );
    return { ok: 1, failed: 0 };
  }

  // Both attempts failed — record why
  await query(
    `update articles
       set rewrite_model = $1,
           rewrite_notes = $2
     where id = $3`,
    [llm.model || "none", llm.notes + contentNote || "no_valid_rewrite", r.id],
  );
  console.log(`⚠️  [${r.id}] Failed validation (incl. retry): "${r.title.slice(0, 50)}..."`);
  return { ok: 0, failed: 1 };
}

async function batch(limit = 40, concurrency = 4) {
  const rows = await fetchBatch(limit);
  console.log(`📝 Processing ${rows.length} articles...`);

  let ok = 0;
  let failed = 0;

  await mapLimit(rows, concurrency, async (r) => {
    const res = await processOne(r);
    ok += res.ok;
    failed += res.failed;
  });

  return { count: rows.length, ok, failed };
}

export async function run(opts: { limit?: number; closePool?: boolean } = {}) {
  console.log("🔄 Starting headline rewrite job...");
  const start = Date.now();

  const res = await batch(opts.limit ?? 40, 4);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `✅ Rewrite complete: ${res.ok} succeeded, ${res.failed} failed (${elapsed}s)`,
  );

  if (opts.closePool) await endPool();
  return res;
}

// CLI support: `bun scripts/rewrite.ts [--dry-run] [--limit N]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliOpts = parseCliArgs(process.argv.slice(2));

  if (cliOpts.dryRun) {
    dryRun(cliOpts.limit ?? 10)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("❌ Fatal error:", err);
        process.exit(1);
      });
  } else {
    run({ ...cliOpts, closePool: true })
      .then((r) => {
        console.log("\n📊 Final results:", r);
        process.exit(r.ok > 0 ? 0 : 1);
      })
      .catch((err) => {
        console.error("❌ Fatal error:", err);
        process.exit(1);
      });
  }
}

type CliOptions = {
  limit?: number;
  dryRun?: boolean;
};

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run" || arg === "-n") {
      opts.dryRun = true;
      continue;
    }

    if (arg === "--limit" || arg === "-l") {
      const next = argv[i + 1];
      if (!next) {
        console.warn("⚠️  --limit flag provided without a value; ignoring");
        continue;
      }
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        opts.limit = Math.max(1, Math.floor(parsed));
      } else {
        console.warn(`⚠️  Invalid --limit value "${next}"; ignoring`);
      }
      i++;
      continue;
    }

    const limitMatch = arg.match(/^--limit=(.+)$/);
    if (limitMatch) {
      const parsed = Number(limitMatch[1]);
      if (Number.isFinite(parsed)) {
        opts.limit = Math.max(1, Math.floor(parsed));
      } else {
        console.warn(`⚠️  Invalid --limit value "${limitMatch[1]}"; ignoring`);
      }
      continue;
    }
  }

  return opts;
}

/* ========================= Dry-Run Mode ========================== */

async function dryRun(limit = 10) {
  console.log("🔍 DRY RUN — generating rewrites without saving\n");

  const rows = await fetchBatch(limit);
  console.log(`Found ${rows.length} articles to process\n`);
  console.log("═".repeat(80));

  let passed = 0;
  let failed = 0;
  let retried = 0;

  for (const r of rows) {
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

    const sourceQuant = buildSourceQuantContext([
      r.title,
      r.dek,
      contentSnippet,
      previewExcerpt,
      r.content_text,
      r.content_html,
    ]);

    const promptInput: PromptInput = {
      title: r.title,
      dek: r.dek,
      contentSnippet,
      previewExcerpt,
    };

    const validationContext: ValidationContext = {
      hasContent: !!contentSnippet,
      sourceQuant,
    };

    const llm = await generateWithOpenAI(promptInput);
    const draft = llm.text || "";
    const pass1 = passesChecks(r.title, draft, validationContext);

    let finalDraft = draft;
    let finalPass = pass1;
    let wasRetry = false;

    if (!pass1 && draft) {
      const retryLlm = await generateWithOpenAI(promptInput, {
        systemPrompt: RETRY_SYSTEM_PROMPT,
      });
      const retryDraft = retryLlm.text || "";
      finalPass = passesChecks(r.title, retryDraft, validationContext);
      if (finalPass) {
        finalDraft = retryDraft;
        wasRetry = true;
        retried++;
      }
    }

    const status = finalPass ? (wasRetry ? "✅ PASS (retry)" : "✅ PASS") : "❌ FAIL";
    const hasContent = contentSnippet ? "with content" : "no content";

    console.log(`\n[${r.id}] ${status} | ${hasContent} | ${r.content_status ?? "null"}`);
    console.log(`  ORIGINAL: ${r.title}`);
    if (r.dek) console.log(`  DEK:      ${r.dek.slice(0, 120)}${r.dek.length > 120 ? "..." : ""}`);
    console.log(`  REWRITE:  ${finalDraft || "(empty)"}`);
    console.log(`  CHARS:    ${finalDraft.length} | WORDS: ${finalDraft.split(/\s+/).length}`);
    if (!pass1 && draft) {
      console.log(`  ATTEMPT1: ${draft}`);
    }
    console.log("─".repeat(80));

    if (finalPass) passed++;
    else failed++;
  }

  console.log("\n" + "═".repeat(80));
  console.log(`📊 DRY RUN RESULTS: ${passed} passed, ${failed} failed, ${retried} recovered via retry`);
  console.log(`   Pass rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  console.log("═".repeat(80));

  await endPool();
}
