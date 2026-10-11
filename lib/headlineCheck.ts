// lib/headlineCheck.ts
// Asks Jev whether a rewritten headline is supported by what the rewrite model
// was shown. It checks the headline against the article's own text, not
// against the world: a faithful headline for a wrong article passes.
//
// Shadow mode: scripts/rewrite.ts records the answer for accepted headlines
// when HEADLINE_CHECK_ENABLED=1 and never blocks one. validateHeadline
// (lib/rewriteShared.ts) stays the gate; its rules cannot see an invented
// attribution, which is what this looks for.

import { query } from "@/lib/db";
import {
  JEV_MODEL_ID,
  booleanProbability,
  evaluateWithJev,
  type JevAnswer,
  type JevEvaluateFn,
  type JevQuestion,
  type JevState,
} from "@/lib/jev";
import { formatPublishedDate, type PromptInput } from "@/lib/rewriteShared";

export const HEADLINE_CHECK_VERSION = "2026-09-29";

/** Short: a slow check must not eat the rewrite cron's 45s budget. */
const CALL_TIMEOUT_MS = 6_000;
const SOURCE_MAX_CHARS = 6_000;
const FLAG_BELOW = 0.5;

export const HEADLINE_CHECK_QUESTIONS: Record<string, JevQuestion> = {
  supported: {
    type: "boolean",
    instructions:
      "Is every factual claim in rewritten_headline stated in or directly supported by source_text? Answer no if rewritten_headline states a number, name, place, cause, or action that source_text does not state. The publication date in source_text counts as stated.",
  },
  invented_attribution: {
    type: "boolean",
    instructions:
      "Does rewritten_headline say that a named person or organization reported, said, warned, forecast, found, or announced something, when source_text never mentions that person or organization?",
  },
  publishable: {
    type: "boolean",
    instructions:
      "Would a careful news editor publish rewritten_headline as an accurate and specific headline for the article in source_text?",
  },
};

export type HeadlineCheck = {
  supportedP: number;
  inventedAttributionP: number;
  publishableP: number;
};

export type HeadlineCheckResult = {
  check: HeadlineCheck;
  inputTokens: number | null;
  latencyMs: number;
};

export function headlineCheckEnabled(): boolean {
  return process.env.HEADLINE_CHECK_ENABLED === "1";
}

/** Exactly what the rewrite model was shown, labelled the same way. */
export function buildHeadlineCheckState(
  input: PromptInput,
  headline: string,
): JevState {
  const lines = [`Original headline: ${input.title}`];
  const published = formatPublishedDate(input.publishedAt);
  if (published) lines.push(`Published: ${published}`);
  if (input.dek) lines.push(`Summary: ${input.dek}`);
  if (input.contentSnippet) {
    lines.push(`Article excerpt: ${input.contentSnippet}`);
  }
  if (input.previewExcerpt) {
    lines.push(`Full article excerpt: ${input.previewExcerpt}`);
  }
  return {
    source_text: lines.join("\n").slice(0, SOURCE_MAX_CHARS),
    rewritten_headline: headline,
  };
}

export function parseHeadlineCheck(
  answers: Record<string, JevAnswer>,
): HeadlineCheck {
  return {
    supportedP: booleanProbability(answers, "supported"),
    inventedAttributionP: booleanProbability(answers, "invented_attribution"),
    publishableP: booleanProbability(answers, "publishable"),
  };
}

/** Whether the check would have stopped the headline, had it been a gate. */
export function isHeadlineFlagged(check: HeadlineCheck): boolean {
  return check.supportedP < FLAG_BELOW;
}

/** Throws on transport or parse failure. */
export async function checkHeadline(
  input: PromptInput,
  headline: string,
  opts: { evaluateFn?: JevEvaluateFn; timeoutMs?: number } = {},
): Promise<HeadlineCheckResult> {
  const started = Date.now();
  const response = await (opts.evaluateFn ?? evaluateWithJev)({
    state: buildHeadlineCheckState(input, headline),
    questions: HEADLINE_CHECK_QUESTIONS,
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
    maxRetries: 0,
  });
  return {
    check: parseHeadlineCheck(response.answers),
    inputTokens: response.inputTokens,
    latencyMs: Date.now() - started,
  };
}

/** Stops checking after repeated failures, so a dead provider costs little. */
export class HeadlineCheckBreaker {
  private consecutive = 0;
  constructor(private readonly threshold = 3) {}
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

export async function storeHeadlineCheck(args: {
  articleId: number;
  headline: string;
  hasContent: boolean;
  outcome: HeadlineCheckResult | { error: string; latencyMs: number };
}): Promise<void> {
  const result = "check" in args.outcome ? args.outcome : null;
  await query(
    `insert into headline_checks
       (article_id, headline, has_content, model, check_version, status,
        error_msg, supported_p, invented_attribution_p, publishable_p,
        input_tokens, latency_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      args.articleId,
      args.headline.slice(0, 500),
      args.hasContent,
      JEV_MODEL_ID,
      HEADLINE_CHECK_VERSION,
      result ? "ok" : "error",
      "error" in args.outcome ? args.outcome.error.slice(0, 300) : null,
      result?.check.supportedP ?? null,
      result?.check.inventedAttributionP ?? null,
      result?.check.publishableP ?? null,
      result?.inputTokens ?? null,
      args.outcome.latencyMs,
    ],
  );
}

/**
 * Check an accepted headline and record the answer. Never throws and never
 * changes what is published: a failure here must not cost a rewrite.
 */
export async function shadowCheckHeadline(args: {
  articleId: number;
  input: PromptInput;
  headline: string;
  breaker: HeadlineCheckBreaker;
}): Promise<void> {
  if (!headlineCheckEnabled() || args.breaker.tripped) return;

  const started = Date.now();
  const hasContent = !!args.input.contentSnippet;
  try {
    const outcome = await checkHeadline(args.input, args.headline);
    args.breaker.recordSuccess();
    await storeHeadlineCheck({
      articleId: args.articleId,
      headline: args.headline,
      hasContent,
      outcome,
    });
    if (isHeadlineFlagged(outcome.check)) {
      console.log(
        `🔎 [${args.articleId}] headline check would flag this (supported ${outcome.check.supportedP.toFixed(2)})`,
      );
    }
  } catch (error) {
    args.breaker.recordError();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `⚠️  [${args.articleId}] headline check failed: ${message.slice(0, 120)}`,
    );
    try {
      await storeHeadlineCheck({
        articleId: args.articleId,
        headline: args.headline,
        hasContent,
        outcome: { error: message, latencyMs: Date.now() - started },
      });
    } catch {
      // The table may not exist yet (`bun run schema`); nothing to record.
    }
  }
}
