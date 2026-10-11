import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { APICallError } from "ai";

import { REWRITE_MODELS } from "@/lib/rewriteShared";
import {
  LlmCircuitBreaker,
  buildFailedNotes,
  generateHeadline,
  shouldFallback,
} from "../rewrite";

type Generate = NonNullable<Parameters<typeof generateHeadline>[1]>["generate"];

const [PRIMARY, FALLBACK] = REWRITE_MODELS;
const input = { title: "EPA repeals power plant emission limits" };

function apiError(statusCode: number) {
  return new APICallError({
    message: `http ${statusCode}`,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode,
  });
}

const answer = (text: string) => () => ({
  text,
  finishReason: "stop",
  usage: {
    inputTokens: 900,
    outputTokens: 20,
    inputTokenDetails: { cacheReadTokens: 800 },
  },
});
const reject = (error: unknown) => () => {
  throw error;
};

/** Stand-in for generateText: behaves per model id and records the calls. */
function stubGenerate(behaviour: Record<string, () => unknown>) {
  const calls: string[] = [];
  const generate = (async (args: { model: { modelId: string } }) => {
    calls.push(args.model.modelId);
    return behaviour[args.model.modelId]();
  }) as unknown as NonNullable<Generate>;
  return { generate, calls };
}

describe("shouldFallback", () => {
  it("does not retry auth, bad-request or unknown-model errors elsewhere", () => {
    for (const status of [400, 401, 403, 404]) {
      assert.equal(shouldFallback(apiError(status)), false, String(status));
    }
  });

  it("retries rate limits, server errors and timeouts on the fallback", () => {
    for (const status of [429, 500, 529]) {
      assert.equal(shouldFallback(apiError(status)), true, String(status));
    }
    assert.equal(shouldFallback(new Error("The operation was aborted")), true);
  });
});

describe("generateHeadline fallback", () => {
  it("answers with the fallback model after a retryable primary error", async () => {
    const { generate, calls } = stubGenerate({
      [PRIMARY.id]: reject(apiError(529)),
      [FALLBACK.id]: answer(
        "EPA finalizes repeal of power plant carbon limits",
      ),
    });
    const result = await generateHeadline(input, { generate });
    assert.deepEqual(calls, [PRIMARY.id, FALLBACK.id]);
    assert.equal(result.model, FALLBACK.id);
    assert.equal(
      result.text,
      "EPA finalizes repeal of power plant carbon limits",
    );
    assert.match(result.notes, /^success:.*via_fallback/);
    assert.equal(result.cachedTokens, 800);
  });

  it("does not call the fallback on an auth error", async () => {
    const { generate, calls } = stubGenerate({
      [PRIMARY.id]: reject(apiError(401)),
      [FALLBACK.id]: answer("never used"),
    });
    const result = await generateHeadline(input, { generate });
    assert.deepEqual(calls, [PRIMARY.id]);
    assert.equal(result.text, null);
    assert.equal(result.model, PRIMARY.id);
    assert.match(result.notes, /^failed:/);
  });

  it("attributes a double failure to the primary and names both models", async () => {
    const { generate } = stubGenerate({
      [PRIMARY.id]: reject(apiError(529)),
      [FALLBACK.id]: reject(apiError(500)),
    });
    const result = await generateHeadline(input, { generate });
    assert.equal(result.text, null);
    assert.equal(result.model, PRIMARY.id);
    assert.match(result.notes, new RegExp(`${PRIMARY.id}: http 529`));
    assert.match(result.notes, new RegExp(`${FALLBACK.id}: http 500`));
  });

  it("skips the fallback when the run budget is nearly spent", async () => {
    const { generate, calls } = stubGenerate({
      [PRIMARY.id]: reject(apiError(529)),
      [FALLBACK.id]: answer("never used"),
    });
    const result = await generateHeadline(input, {
      generate,
      deadlineAt: Date.now() + 500,
    });
    assert.deepEqual(calls, [PRIMARY.id]);
    assert.equal(result.text, null);
  });

  it("returns empty text, not a transport error, for an empty answer", async () => {
    const { generate } = stubGenerate({ [PRIMARY.id]: answer("") });
    const result = await generateHeadline(input, { generate });
    assert.equal(result.text, "");
    assert.equal(result.model, PRIMARY.id);
  });
});

describe("LlmCircuitBreaker", () => {
  it("trips after the threshold of consecutive errors", () => {
    const breaker = new LlmCircuitBreaker(3);
    breaker.recordError();
    breaker.recordError();
    assert.equal(breaker.tripped, false);
    breaker.recordError();
    assert.equal(breaker.tripped, true);
  });

  it("any success resets the consecutive counter", () => {
    const breaker = new LlmCircuitBreaker(3);
    breaker.recordError();
    breaker.recordError();
    breaker.recordSuccess();
    breaker.recordError();
    breaker.recordError();
    assert.equal(breaker.tripped, false);
    breaker.recordError();
    assert.equal(breaker.tripped, true);
  });

  it("defaults to a threshold of 5", () => {
    const breaker = new LlmCircuitBreaker();
    for (let i = 0; i < 4; i++) breaker.recordError();
    assert.equal(breaker.tripped, false);
    breaker.recordError();
    assert.equal(breaker.tripped, true);
  });
});

describe("buildFailedNotes", () => {
  it("writes failed_validation:<reason> for validation failures (never 'success:')", () => {
    const notes = buildFailedNotes(
      "numeric_mismatch",
      "success:with_content:800chars",
      ":no_content",
    );
    assert.equal(notes, "failed_validation:numeric_mismatch:no_content");
    assert.ok(!notes.startsWith("success:"));
  });

  it("preserves the provider message for llm_error, bounded to 160 chars", () => {
    const longMsg = "failed:" + "x".repeat(500);
    const notes = buildFailedNotes("llm_error", longMsg, ":error");
    assert.ok(notes.startsWith("failed:"));
    assert.ok(notes.length <= 160 + ":error".length);
    assert.ok(notes.endsWith(":error"));
  });

  it("keeps contentNote suffix for validation failures", () => {
    const notes = buildFailedNotes(
      "missing_attribution",
      "success:title_only",
      "",
    );
    assert.equal(notes, "failed_validation:missing_attribution");
  });
});
