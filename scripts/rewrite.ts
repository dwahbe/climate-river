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
function extractContentSnippet(
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

  // 🛡️ SAFETY CHECK 2: Detect paywall language
  const paywallPatterns = [
    /subscribe/i,
    /subscription/i,
    /sign in/i,
    /member/i,
    /premium/i,
    /paywall/i,
  ];
  const firstPart = cleaned.slice(0, 200);
  const paywallMatch = paywallPatterns.find((p) => p.test(firstPart));
  if (paywallMatch) {
    console.warn(
      `⚠️  ${idLabel}Paywall detected ("${paywallMatch.source}"): "${firstPart.slice(0, 80)}..."`,
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

function buildPrompt(input: {
  title: string;
  dek?: string | null;
  contentSnippet?: string | null;
  previewExcerpt?: string | null;
}) {
  const lines = [
    "Rewrite this climate news headline in the style of Techmeme - dense, factual, scannable, with all key details.",
    "",
    "STRUCTURE (Techmeme style):",
    "- Lead with WHO (agency/company/court/institution)",
    "- Follow with strong action verb (announces, blocks, requires, finds, cuts, raises)",
    "- Add specific WHAT with details; only cite numbers that were provided",
    "- End with WHY/IMPACT in natural clause",
    "- Use commas to separate clauses, not complex sentence structures",
    "- Write what WAS FOUND, HAPPENED, or CHANGED - never what was 'reported on'",
    "- The headline IS the news, not a description of coverage",
    "",
    "SPECIFICITY REQUIRED:",
    "- ONLY include numbers or quantitative claims that appear in the supplied material (title, summary, excerpt, preview article, or cluster context)",
    "- If no quantitative details exist, keep the rewrite qualitative but still concrete",
    "- Do not invent stats, measurements, dates, or sources; omit missing data instead of guessing",
    "- Preview excerpts (when provided) are the verified article text—quote them faithfully",
    '- Name specific entities: "EPA", "Ørsted", "Federal Appeals Court", not "regulators" or "companies"',
    '- Include timeframes: "by 2030", "from 2025-2028", "starting Q1 2026"',
    "- Product/policy names: Exact titles, not generic descriptions",
    "- Give concrete examples when possible",
    "",
    "CLIMATE-SPECIFIC PATTERNS:",
    '- Policy: "[Agency] [action verb] [rule/standard], requiring [entities] to [specific action] by [date], citing [reason]"',
    '  Example: "EPA finalizes power plant emissions rule, requiring coal facilities to cut CO2 80% by 2032, citing climate goals"',
    "",
    '- Corporate: "[Company] [action] [project/investment], [size/scale with numbers], [reason/context]"',
    '  Example: "Ørsted cancels 2.6GW New Jersey offshore wind project, cites supply chain costs and rate caps"',
    "",
    '- Legal: "[Court level] [ruling action] [case/project], citing [specific legal issue]"',
    '  Example: "Federal appeals court blocks Mountain Valley Pipeline, citing insufficient climate impact review"',
    "",
    '- Science: "[Institution] study finds [specific finding], [magnitude/numbers], [implication]"',
    '  Example: "Nature study finds Amazon emitting more CO2 than it absorbs, driven by 15% deforestation increase"',
    "",
    '- Technology: "[Company] [announces/demonstrates] [technology], achieving [metrics], targeting [application]"',
    '  Example: "Form Energy demonstrates 100-hour iron-air battery, targets grid-scale seasonal storage"',
    "",
    '- Qualitative (when no numbers in source): "[Entity] [action] [specific thing], citing [reason]"',
    '  Example: "Fashion for Good releases decarbonization blueprint, offering practical factory-level guidance"',
    '  Example: "Indigenous groups blockade COP30 entrance, protesting lack of forest protection commitments"',
    "",
    "BAD vs GOOD (avoid vague meta-headlines):",
    '- BAD: "Study raises concerns about microplastics in human bodies"',
    '- GOOD: "Study finds microplastics in 87% of human tissue samples, highest concentrations in lungs"',
    "",
    '- BAD: "Report shows climate barometer falls, citing challenges"',
    '- GOOD: "RBC Climate Barometer drops 12 points to 47, lowest since 2021"',
    "",
    '- BAD: "Company announces progress on wind project"',
    '- GOOD: "Ørsted resumes 2.6GW Ocean Wind project after 9th Circuit blocks permit freeze"',
    "",
    "STYLE RULES:",
    "- Present tense, active voice",
    "- 120-160 characters ideal (Techmeme density)",
    "- No period at end",
    "- Repeat quantitative figures exactly as provided; no rounding or new units",
    '- No hype words: "revolutionary", "game-changer", "unprecedented", "major breakthrough"',
    '- No vague phrases: "significant", "important" (show don\'t tell with numbers)',
    "- No questions, puns, or editorial voice",
    '- Match certainty level of source: if source states fact ("Trump Won"), rewrite as fact ("Trump wins"), never as speculation',
    '- FORBIDDEN WORDS: "likely", "expected to", "set to", "poised to" - these will cause rejection',
    '- FORBIDDEN META-PATTERNS: "reports on", "raises concerns", "citing challenges", "sparking debate", "health implications", "building momentum"',
    "- If you can't state the specific finding/action/change, the headline will be rejected",
    '- "may"/"could" OK only for scientific projections about future events',
    "",
    "SOURCE MATERIAL:",
    `Original headline: ${input.title}`,
  ];

  if (input.dek) {
    lines.push(`Summary: ${input.dek}`);
  }

  if (input.contentSnippet) {
    lines.push(`Article excerpt: ${input.contentSnippet}`);
    lines.push("");
    lines.push(
      "CONTENT AVAILABLE - You MUST extract at least one specific detail from the article excerpt:",
    );
    lines.push("- A number, percentage, or measurement");
    lines.push("- A specific name, location, or entity");
    lines.push("- A concrete finding, action, or outcome");
    lines.push(
      "Do NOT write a generic summary when specific details exist in the excerpt above.",
    );
  }

  if (input.previewExcerpt) {
    lines.push(
      `Preview article excerpt (from Climate River reader): ${input.previewExcerpt}`,
    );
  }

  lines.push("");
  lines.push(
    "CRITICAL: If a number, percentage, date, or measurement does NOT appear in the source material above, do NOT include it. Wrong numbers = rejected headline. When in doubt, omit the number entirely.",
  );
  lines.push("");
  lines.push(
    'OUTPUT: Rewritten headline only (no quotes, no explanation, no "Here is...")',
  );

  return lines.join("\n");
}

function sanitizeHeadline(s: string) {
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

function buildSourceQuantContext(
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

function passesChecks(
  original: string,
  draft: string,
  context: ValidationContext,
) {
  if (!draft) return false;
  const t = sanitizeHeadline(draft);
  const { hasContent, sourceQuant } = context;

  // Techmeme-style density: allow more flexibility for high-quality specificity
  const minLength = hasContent ? 60 : 50;
  if (t.length < minLength || t.length > 200) {
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

  // Word count check - allow Techmeme-style density (shorter but denser)
  // Lowered thresholds since vaguePatterns validation catches actual quality issues
  const originalWords = original.split(/\s+/).length;
  const draftWords = t.split(/\s+/).length;

  // Very long originals (>30 words) are likely social media posts, not headlines
  // Use much lower threshold since we're condensing a post into a headline
  const isLikelySocialPost = originalWords > 30;

  if (isLikelySocialPost) {
    // Social posts: just ensure we have a reasonable headline (8+ words)
    if (draftWords < 8) {
      console.warn(`⚠️  Headline too short for social post condensation`);
      return false;
    }
  } else if (hasContent) {
    // Normal headline with content: allow denser headlines (70% threshold)
    if (draftWords < originalWords * 0.7) {
      console.warn(`⚠️  Headline too compressed despite having content`);
      return false;
    }
  } else {
    // Normal headline without content: allow Techmeme-style compression (50% threshold)
    if (draftWords < originalWords * 0.5) {
      console.warn(`⚠️  Headline too compressed`);
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

    // Vague concern/debate language
    /\braising concerns\b/i,
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
  ];

  if (vaguePatterns.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected vague/meta-reporting pattern: "${t.slice(0, 50)}..."`);
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
  input: {
    title: string;
    dek?: string | null;
    contentSnippet?: string | null;
    previewExcerpt?: string | null;
  },
  abortMs = 20000,
  retries = 2,
): Promise<{ text: string | null; model: string; notes: string }> {
  const prompt = buildPrompt(input);
  const model = "gpt-4o-mini";

  try {
    const { text } = await generateText({
      model: openai(model),
      prompt,
      temperature: 0.15, // Lower for stricter instruction following
      maxOutputTokens: 50, // Lower - headlines shouldn't need much
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
      ? extractContentSnippet(r.content_text, r.content_html, 600, r.id)
      : null;

  const previewExcerpt =
    r.content_status === "success" &&
    typeof r.content_html === "string" &&
    r.content_html.trim().length > 0
      ? extractContentSnippet(null, r.content_html, 1500, r.id)
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

  const llm = await generateWithOpenAI({
    title: r.title,
    dek: r.dek,
    contentSnippet,
    previewExcerpt,
  });
  const draft = llm.text || "";

  if (
    passesChecks(r.title, draft, {
      hasContent: !!contentSnippet,
      sourceQuant,
    })
  ) {
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

  // Leave original title; just record why it failed.
  await query(
    `update articles
       set rewrite_model = $1,
           rewrite_notes = $2
     where id = $3`,
    [llm.model || "none", llm.notes + contentNote || "no_valid_rewrite", r.id],
  );
  console.log(`⚠️  [${r.id}] Failed validation: "${r.title.slice(0, 50)}..."`);
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

// CLI support: `npm run rewrite`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
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

type CliOptions = {
  limit?: number;
};

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

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
