// scripts/rewrite.ts
import { query, endPool } from "@/lib/db";
import {
  buildRetrySystemPrompt,
  buildSourceQuantContext,
  buildSystemPrompt,
  buildUserPrompt,
  extractContentSnippet,
  formatPublishedDate,
  sanitizeHeadline,
  validateHeadline,
  passesChecks,
  type HeadlineCheck,
  type HeadlineFailureReason,
  type PromptInput,
  type ValidationContext,
} from "@/lib/rewriteShared";

// Re-export the validator (now living in lib/rewriteShared.ts as the single
// source of truth) so existing imports from "../rewrite" and the test suite
// keep working.
export {
  validateHeadline,
  passesChecks,
  type HeadlineCheck,
  type HeadlineFailureReason,
};
import { isClimateRelevant } from "@/lib/tagger";
import { mapLimit } from "@/lib/utils";
import { openai } from "@ai-sdk/openai";
import { gateway, generateText } from "ai";

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

/* ------------------------- LLM Generation ------------------------- */

// OpenAI prompt-cache routing keys. Stable per logical workload — bump the
// suffix when the system prompt changes materially. Each key stays well
// under OpenAI's 15 req/min/prefix-key cache-overflow guidance.
const CACHE_KEY_FIRST_ATTEMPT = "climate-river-rewrite-legacy-v1";
const CACHE_KEY_RETRY = "climate-river-rewrite-legacy-retry-v1";

type GenerateResult = {
  text: string | null;
  model: string;
  notes: string;
  latencyMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  truncated: boolean;
};

/**
 * Batch-level circuit breaker: after `threshold` consecutive LLM transport
 * failures (gateway AND direct fallback both down), stop sending the rest of
 * the batch into a dead provider. Any successful call resets the counter.
 */
export class LlmCircuitBreaker {
  private consecutive = 0;
  constructor(private readonly threshold = 5) {}
  recordError(): void {
    this.consecutive += 1;
  }
  recordSuccess(): void {
    this.consecutive = 0;
  }
  get tripped(): boolean {
    return this.consecutive >= this.threshold;
  }
}

/**
 * rewrite_notes for articles whose attempts all failed. Previously the first
 * attempt's generation notes were written verbatim, which begin "success:"
 * whenever the LLM call itself succeeded — poisoning notes-based monitoring.
 */
export function buildFailedNotes(
  reason: HeadlineFailureReason,
  llmNotes: string,
  contentNote: string,
): string {
  if (reason === "llm_error") {
    // llmNotes is already "failed:<provider message>" — keep it, bounded.
    return `${llmNotes.slice(0, 160)}${contentNote}`;
  }
  return `failed_validation:${reason}${contentNote}`;
}

async function generateWithOpenAI(
  input: PromptInput,
  opts: {
    systemPrompt?: string;
    cacheKey?: string;
    abortMs?: number;
    retries?: number;
  } = {},
): Promise<GenerateResult> {
  const system = opts.systemPrompt ?? buildSystemPrompt("legacy");
  const prompt = buildUserPrompt(input, "legacy");
  const abortMs = opts.abortMs ?? 20000;
  const retries = opts.retries ?? 2;
  const cacheKey = opts.cacheKey ?? CACHE_KEY_FIRST_ATTEMPT;
  const model = "gpt-4.1-mini";
  const startedAt = Date.now();

  const attempt = (direct: boolean) =>
    generateText({
      // Primary route is the Vercel AI Gateway (forwards providerOptions.openai
      // incl. promptCacheKey; OIDC-auths on Vercel, AI_GATEWAY_API_KEY locally).
      // On gateway failure (free-tier 429s killed ~90% of attempts for a month)
      // we fall back to direct OpenAI when OPENAI_API_KEY is configured.
      model: direct ? openai(model) : gateway(`openai/${model}`),
      system,
      prompt,
      temperature: 0.15,
      maxOutputTokens: 80,
      maxRetries: direct ? 1 : retries,
      abortSignal: AbortSignal.timeout(abortMs),
      providerOptions: {
        openai: { promptCacheKey: cacheKey },
      },
    });

  try {
    let result: Awaited<ReturnType<typeof attempt>>;
    let viaDirect = false;
    try {
      result = await attempt(false);
    } catch (gatewayError: unknown) {
      if (!process.env.OPENAI_API_KEY) throw gatewayError;
      const msg =
        gatewayError instanceof Error ? gatewayError.message : "unknown_error";
      console.warn(
        `⚠️  Gateway generation failed (${msg.slice(0, 120)}); retrying via direct OpenAI`,
      );
      result = await attempt(true);
      viaDirect = true;
    }

    const sanitized = sanitizeHeadline(result.text);
    const notesParts = [
      input.contentSnippet
        ? `with_content:${input.contentSnippet.length}chars`
        : "title_only",
    ];
    if (viaDirect) notesParts.push("via_direct");

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
          cachedInputTokens?: number;
          inputTokenDetails?: { cacheReadTokens?: number };
        }
      | undefined;
    // AI SDK v6 exposes cached tokens at usage.inputTokenDetails.cacheReadTokens.
    // Older shapes (usage.cachedInputTokens, providerMetadata.openai.cachedPromptTokens)
    // are kept as fallbacks for forward/back compat. Gateway preserves the
    // unified shape, but we also peek at providerMetadata.gateway as a fallback
    // in case it surfaces cached counts there.
    const openaiMeta = result.providerMetadata?.openai as
      | { cachedPromptTokens?: number }
      | undefined;
    const gatewayMeta = result.providerMetadata?.gateway as
      | { cachedPromptTokens?: number; cachedInputTokens?: number }
      | undefined;
    const cachedTokens =
      usage?.inputTokenDetails?.cacheReadTokens ??
      usage?.cachedInputTokens ??
      openaiMeta?.cachedPromptTokens ??
      gatewayMeta?.cachedInputTokens ??
      gatewayMeta?.cachedPromptTokens ??
      null;

    return {
      text: sanitized,
      model,
      notes: `success:${notesParts.join(":")}`,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage?.inputTokens ?? usage?.promptTokens ?? null,
      outputTokens: usage?.outputTokens ?? usage?.completionTokens ?? null,
      cachedTokens: typeof cachedTokens === "number" ? cachedTokens : null,
      // A "length" finish means the model was cut off at maxOutputTokens —
      // the headline is very likely mid-sentence even if it happens to fit
      // the char limit. Treat as a validation failure (retry may fit).
      truncated: result.finishReason === "length",
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
      cachedTokens: null,
      truncated: false,
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
  cachedTokens: number | null;
  outputTokens: number | null;
}): Promise<void> {
  try {
    await query(
      `insert into rewrite_attempts
         (article_id, attempt_idx, model, latency_ms, accepted,
          validation_failures, prompt_tokens, cached_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
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
        args.cachedTokens,
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
        -- Permafail cap: stop re-selecting articles that already failed
        -- validation 4+ times (llm transport errors don't count — they're the
        -- provider's fault, and the in-run circuit breaker bounds those).
        -- Second chance: if content was (re)fetched after the latest failed
        -- attempt, the article becomes eligible again.
        and not exists (
          select 1
          from rewrite_attempts ra
          where ra.article_id = a.id
            and ra.accepted = false
            and (ra.validation_failures->>'reason') is distinct from 'llm_error'
          having count(*) >= 4
             and max(ra.created_at) >= coalesce(a.content_fetched_at, timestamptz '-infinity')
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

type ProcessOutcome = { ok: number; failed: number; skipped: number };

async function processOne(
  r: Row,
  breaker: LlmCircuitBreaker,
): Promise<ProcessOutcome> {
  if (breaker.tripped) {
    return { ok: 0, failed: 0, skipped: 1 };
  }

  // SAFETY LAYER 1: Only use content if status is explicitly 'success'
  const contentSnippet =
    r.content_status === "success"
      ? extractContentSnippet(r.content_text, r.content_html, 1200, r.id)
      : null;

  const previewExcerptRaw =
    r.content_status === "success" &&
    typeof r.content_html === "string" &&
    r.content_html.trim().length > 0
      ? extractContentSnippet(null, r.content_html, 2500, r.id)
      : null;
  // Snippet and preview are both extracted from the start of the same content;
  // when they're the same text the preview adds tokens without information.
  const previewExcerpt =
    previewExcerptRaw &&
    contentSnippet &&
    previewExcerptRaw.slice(0, 200) === contentSnippet.slice(0, 200)
      ? null
      : previewExcerptRaw;

  // Track what happened with content
  let contentNote = "";
  if (!r.content_status) {
    contentNote = ":no_content";
  } else if (r.content_status !== "success") {
    contentNote = `:${r.content_status}`; // :paywall, :blocked, :timeout, etc.
  } else if (!contentSnippet) {
    contentNote = ":content_rejected"; // Had content but failed quality checks
  }

  // Raw content_text/content_html are only trustworthy as "source" when the
  // prefetch succeeded — otherwise they may hold nav/boilerplate from a blocked
  // or error page, which would wrongly "support" a hallucinated number/entity.
  const trustedContentText =
    r.content_status === "success" ? r.content_text : null;
  const trustedContentHtml =
    r.content_status === "success" ? r.content_html : null;

  // Include the formatted publish date so a legitimate "in 2026" isn't rejected
  // as a number missing from source.
  const publishedDateText = formatPublishedDate(r.published_at);

  // For validating numbers exist: check only this article's own content
  const sourceQuant = buildSourceQuantContext([
    r.title,
    r.dek,
    publishedDateText,
    contentSnippet,
    previewExcerpt,
    trustedContentText,
    trustedContentHtml,
  ]);

  const climateSummaryParts = [
    r.dek,
    contentSnippet,
    previewExcerpt,
    trustedContentText,
    trustedContentHtml,
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
    return { ok: 0, failed: 1, skipped: 0 };
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
    publishedDateText,
    contentSnippet,
    previewExcerpt,
    trustedContentText,
    trustedContentHtml,
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
  if (llm.text === null) breaker.recordError();
  else breaker.recordSuccess();
  const draft = llm.text || "";
  const firstCheck: HeadlineCheck = !llm.text
    ? { ok: false, reason: "llm_error" }
    : llm.truncated
      ? { ok: false, reason: "truncated" }
      : validateHeadline(r.title, draft, validationContext);

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
    cachedTokens: llm.cachedTokens,
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
    return { ok: 1, failed: 0, skipped: 0 };
  }

  // A transport failure is not a validation failure: the "previous attempt was
  // too vague" retry prompt makes no sense and just doubles load on a
  // rate-limited provider. Record the failure and move on.
  if (firstCheck.reason === "llm_error") {
    await query(
      `update articles
         set rewrite_model = $1,
             rewrite_notes = $2
       where id = $3`,
      [
        llm.model || "none",
        buildFailedNotes("llm_error", llm.notes, contentNote),
        r.id,
      ],
    );
    console.log(`⚠️  [${r.id}] LLM transport error; skipping retry prompt`);
    return { ok: 0, failed: 1, skipped: 0 };
  }

  // Retry once with a more direct prompt — different system prompt means a
  // different stable prefix, so route it under its own cache key.
  const retryLlm = await generateWithOpenAI(promptInput, {
    systemPrompt: buildRetrySystemPrompt("legacy"),
    cacheKey: CACHE_KEY_RETRY,
  });
  if (retryLlm.text === null) breaker.recordError();
  else breaker.recordSuccess();
  const retryDraft = retryLlm.text || "";
  const retryCheck: HeadlineCheck = !retryLlm.text
    ? { ok: false, reason: "llm_error" }
    : retryLlm.truncated
      ? { ok: false, reason: "truncated" }
      : validateHeadline(r.title, retryDraft, validationContext);

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
    cachedTokens: retryLlm.cachedTokens,
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
    return { ok: 1, failed: 0, skipped: 0 };
  }

  // Both attempts failed — record the final validation reason honestly
  const failReason = retryCheck.reason ?? "empty";
  await query(
    `update articles
       set rewrite_model = $1,
           rewrite_notes = $2
     where id = $3`,
    [
      retryLlm.model || llm.model || "none",
      buildFailedNotes(failReason, retryLlm.notes, contentNote),
      r.id,
    ],
  );
  console.log(
    `⚠️  [${r.id}] Failed validation (incl. retry): "${r.title.slice(0, 50)}..."`,
  );
  return { ok: 0, failed: 1, skipped: 0 };
}

async function batch(limit = 40, concurrency = 4, deadlineAt = Infinity) {
  const rows = await fetchBatch(limit);
  console.log(`📝 Processing ${rows.length} articles...`);

  const breaker = new LlmCircuitBreaker();
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  await mapLimit(rows, concurrency, async (r) => {
    // Budget guard: don't start new articles past the deadline — Vercel kills
    // the function at maxDuration with no pipeline_runs record otherwise.
    if (Date.now() > deadlineAt) {
      skipped += 1;
      return;
    }
    const res = await processOne(r, breaker);
    ok += res.ok;
    failed += res.failed;
    skipped += res.skipped;
  });

  if (breaker.tripped) {
    console.warn(
      `🛑 Circuit breaker tripped after consecutive LLM transport errors; skipped ${skipped} articles`,
    );
  }

  return {
    count: rows.length,
    ok,
    failed,
    skipped,
    breakerTripped: breaker.tripped,
  };
}

export async function run(
  opts: { limit?: number; closePool?: boolean; deadlineMs?: number } = {},
) {
  console.log("🔄 Starting headline rewrite job...");
  const start = Date.now();
  const deadlineAt = opts.deadlineMs ? start + opts.deadlineMs : Infinity;

  const res = await batch(opts.limit ?? 40, 4, deadlineAt);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `✅ Rewrite complete: ${res.ok} succeeded, ${res.failed} failed, ${res.skipped} skipped (${elapsed}s)`,
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
    // Mirror production retry semantics exactly: retry only on validation
    // failure, never on transport error.
    const check: HeadlineCheck = llm.text
      ? validateHeadline(r.title, draft, validationContext)
      : { ok: false, reason: "llm_error" };
    const pass1 = check.ok;

    let finalDraft = draft;
    let finalPass = pass1;
    let wasRetry = false;

    if (!pass1 && check.reason !== "llm_error") {
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
    console.log(
      `  USAGE:    model=${llm.model} | in=${llm.promptTokens ?? "?"} cached=${llm.cachedTokens ?? "?"} out=${llm.outputTokens ?? "?"} | ${llm.latencyMs}ms`,
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
