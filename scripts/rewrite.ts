// scripts/rewrite.ts
import { query, endPool } from "@/lib/db";
import {
  ATTRIBUTION_REQUIRED_SOURCE_PATTERNS,
  ATTRIBUTION_TRIGGER_PATTERNS,
  CLICKBAIT_PATTERNS,
  POLITICAL_FIGURES,
  VAGUE_PATTERNS,
  WEAK_PATTERNS,
  WEAK_PRIORITIZATION_PATTERNS,
  buildRetrySystemPrompt,
  buildSourceQuantContext,
  buildSystemPrompt,
  buildUserPrompt,
  containsQuantifier,
  extractContentSnippet,
  extractNumericTokens,
  hasAttribution,
  sanitizeHeadline,
  type PromptInput,
  type ValidationContext,
} from "@/lib/rewriteShared";
import { isClimateRelevant } from "@/lib/tagger";
import { mapLimit } from "@/lib/utils";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

type Row = {
  id: number;
  title: string;
  dek: string | null;
  canonical_url: string;
  content_text: string | null;
  content_html: string | null;
  content_status: string | null;
  published_at: string | null;
};

const MAX_SOURCE_SEGMENT = 12_000;

/* ------------------------- Enhanced Validation ------------------------- */

export type HeadlineFailureReason =
  | "empty"
  | "length"
  | "unchanged"
  | "too_short_social"
  | "too_compressed"
  | "too_short_no_content"
  | "numeric_missing_in_source"
  | "numeric_mismatch"
  | "hallucinated_political_figure"
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

  const draftNumbers = extractNumericTokens(t);
  if (draftNumbers.length > 0) {
    if (sourceQuant.numbers.size === 0) {
      console.warn(
        `⚠️  Numeric detail missing in source but present in rewrite: ${draftNumbers.join(
          ", ",
        )}`,
      );
      return { ok: false, reason: "numeric_missing_in_source" };
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

  if (CLICKBAIT_PATTERNS.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected vague/hype language: "${t.slice(0, 50)}..."`);
    return { ok: false, reason: "clickbait" };
  }

  if (WEAK_PATTERNS.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected weak hedging language: "${t.slice(0, 50)}..."`);
    return { ok: false, reason: "weak_hedging" };
  }

  if (VAGUE_PATTERNS.some((p) => p.test(t))) {
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
 * Existing tests assert against this signature.
 */
export function passesChecks(
  original: string,
  draft: string,
  context: ValidationContext,
): boolean {
  return validateHeadline(original, draft, context).ok;
}

/* ------------------------- LLM Generation ------------------------- */

type GenerateResult = {
  text: string | null;
  model: string;
  notes: string;
  latencyMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
};

async function generateWithOpenAI(
  input: PromptInput,
  opts: {
    systemPrompt?: string;
    abortMs?: number;
    retries?: number;
  } = {},
): Promise<GenerateResult> {
  const system = opts.systemPrompt ?? buildSystemPrompt("legacy");
  const prompt = buildUserPrompt(input, "legacy");
  const abortMs = opts.abortMs ?? 20000;
  const retries = opts.retries ?? 2;
  const model = "gpt-4.1-mini";
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model: openai(model),
      system,
      prompt,
      temperature: 0.15,
      maxOutputTokens: 80,
      maxRetries: retries,
      abortSignal: AbortSignal.timeout(abortMs),
    });

    const sanitized = sanitizeHeadline(result.text);
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

    const usage = result.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
        }
      | undefined;

    return {
      text: sanitized,
      model,
      notes: `success:${notesParts.join(":")}`,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage?.inputTokens ?? usage?.promptTokens ?? null,
      outputTokens: usage?.outputTokens ?? usage?.completionTokens ?? null,
    };
  } catch (error: unknown) {
    console.error("❌ Error generating text with AI SDK:", error);
    const message = error instanceof Error ? error.message : "unknown_error";
    return {
      text: null,
      model,
      notes: `failed:${message}`,
      latencyMs: Date.now() - startedAt,
      promptTokens: null,
      outputTokens: null,
    };
  }
}

/**
 * Telemetry insert. Awaited so it completes before the pool closes; errors
 * are swallowed so a logging failure never breaks a rewrite.
 */
async function logAttempt(args: {
  articleId: number;
  attemptIdx: number;
  model: string;
  latencyMs: number;
  accepted: boolean;
  validationFailures: object | null;
  promptTokens: number | null;
  outputTokens: number | null;
}): Promise<void> {
  try {
    await query(
      `insert into rewrite_attempts
         (article_id, attempt_idx, model, latency_ms, accepted,
          validation_failures, prompt_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        args.articleId,
        args.attemptIdx,
        args.model,
        args.latencyMs,
        args.accepted,
        args.validationFailures === null
          ? null
          : JSON.stringify(args.validationFailures),
        args.promptTokens,
        args.outputTokens,
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Failed to log rewrite attempt: ${msg}`);
  }
}

/* ------------------------------- Runner -------------------------------- */

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
        a.content_status,
        a.published_at
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
    publishedAt: r.published_at,
  };

  const sourceText = [
    r.title,
    r.dek,
    contentSnippet,
    previewExcerpt,
    r.content_text,
    r.content_html,
  ]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((s) =>
      s.length > MAX_SOURCE_SEGMENT ? s.slice(0, MAX_SOURCE_SEGMENT) : s,
    )
    .join(" ");

  const validationContext: ValidationContext = {
    hasContent: !!contentSnippet,
    sourceQuant,
    sourceText,
  };

  // First attempt
  const llm = await generateWithOpenAI(promptInput);
  const draft = llm.text || "";
  const firstCheck: HeadlineCheck = llm.text
    ? validateHeadline(r.title, draft, validationContext)
    : { ok: false, reason: "llm_error" };

  await logAttempt({
    articleId: r.id,
    attemptIdx: 1,
    model: llm.model,
    latencyMs: llm.latencyMs,
    accepted: firstCheck.ok,
    validationFailures: firstCheck.ok
      ? null
      : { reason: firstCheck.reason, notes: llm.notes },
    promptTokens: llm.promptTokens,
    outputTokens: llm.outputTokens,
  });

  if (firstCheck.ok) {
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
    systemPrompt: buildRetrySystemPrompt("legacy"),
  });
  const retryDraft = retryLlm.text || "";
  const retryCheck: HeadlineCheck = retryLlm.text
    ? validateHeadline(r.title, retryDraft, validationContext)
    : { ok: false, reason: "llm_error" };

  await logAttempt({
    articleId: r.id,
    attemptIdx: 2,
    model: retryLlm.model,
    latencyMs: retryLlm.latencyMs,
    accepted: retryCheck.ok,
    validationFailures: retryCheck.ok
      ? null
      : { reason: retryCheck.reason, notes: retryLlm.notes },
    promptTokens: retryLlm.promptTokens,
    outputTokens: retryLlm.outputTokens,
  });

  if (retryCheck.ok) {
    const notes =
      retryLlm.notes.replace("success:", "success:retry:") + contentNote;
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
  console.log(
    `⚠️  [${r.id}] Failed validation (incl. retry): "${r.title.slice(0, 50)}..."`,
  );
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
      publishedAt: r.published_at,
    };

    const sourceText = [
      r.title,
      r.dek,
      contentSnippet,
      previewExcerpt,
      r.content_text,
      r.content_html,
    ]
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((s) =>
        s.length > MAX_SOURCE_SEGMENT ? s.slice(0, MAX_SOURCE_SEGMENT) : s,
      )
      .join(" ");

    const validationContext: ValidationContext = {
      hasContent: !!contentSnippet,
      sourceQuant,
      sourceText,
    };

    const llm = await generateWithOpenAI(promptInput);
    const draft = llm.text || "";
    const pass1 = passesChecks(r.title, draft, validationContext);

    let finalDraft = draft;
    let finalPass = pass1;
    let wasRetry = false;

    if (!pass1 && draft) {
      const retryLlm = await generateWithOpenAI(promptInput, {
        systemPrompt: buildRetrySystemPrompt("legacy"),
      });
      const retryDraft = retryLlm.text || "";
      finalPass = passesChecks(r.title, retryDraft, validationContext);
      if (finalPass) {
        finalDraft = retryDraft;
        wasRetry = true;
        retried++;
      }
    }

    const status = finalPass
      ? wasRetry
        ? "✅ PASS (retry)"
        : "✅ PASS"
      : "❌ FAIL";
    const hasContent = contentSnippet ? "with content" : "no content";

    console.log(
      `\n[${r.id}] ${status} | ${hasContent} | ${r.content_status ?? "null"}`,
    );
    console.log(`  ORIGINAL: ${r.title}`);
    if (r.dek)
      console.log(
        `  DEK:      ${r.dek.slice(0, 120)}${r.dek.length > 120 ? "..." : ""}`,
      );
    console.log(`  REWRITE:  ${finalDraft || "(empty)"}`);
    console.log(
      `  CHARS:    ${finalDraft.length} | WORDS: ${finalDraft.split(/\s+/).length}`,
    );
    if (!pass1 && draft) {
      console.log(`  ATTEMPT1: ${draft}`);
    }
    console.log("─".repeat(80));

    if (finalPass) passed++;
    else failed++;
  }

  console.log("\n" + "═".repeat(80));
  console.log(
    `📊 DRY RUN RESULTS: ${passed} passed, ${failed} failed, ${retried} recovered via retry`,
  );
  console.log(
    `   Pass rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`,
  );
  console.log("═".repeat(80));

  await endPool();
}
