import {
  DEFAULT_EVAL_PROFILES,
  type EvalProfile,
  type PromptVariant,
} from "@/config/evalProfiles";
import { query } from "@/lib/db";
import { resolveModel } from "@/lib/evalProviders";
import {
  ATTRIBUTION_REQUIRED_SOURCE_PATTERNS,
  ATTRIBUTION_TRIGGER_PATTERNS,
  CLICKBAIT_PATTERNS,
  POLITICAL_FIGURES,
  VAGUE_PATTERNS,
  WEAK_PATTERNS,
  WEAK_PRIORITIZATION_PATTERNS,
  buildSourceQuantContext,
  buildSystemPrompt,
  buildRetrySystemPrompt,
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
import { generateText } from "ai";

export type { EvalProfile, PromptVariant } from "@/config/evalProfiles";
export { buildSystemPrompt, buildUserPrompt } from "@/lib/rewriteShared";

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

export type { ValidationContext } from "@/lib/rewriteShared";

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


function failValidation(
  code: RewriteFailureCode,
  message: string,
  preview?: string,
): RewriteValidationResult {
  const suffix = preview ? `: "${preview.slice(0, 60)}..."` : "";
  console.warn(`⚠️  ${message}${suffix}`);
  return { ok: false, code, message };
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

  const srcLower = context.sourceText.toLowerCase();
  const draftLower = t.toLowerCase();
  for (const name of POLITICAL_FIGURES) {
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
