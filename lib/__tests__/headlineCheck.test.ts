import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HEADLINE_CHECK_QUESTIONS,
  HeadlineCheckBreaker,
  buildHeadlineCheckState,
  checkHeadline,
  isHeadlineFlagged,
  parseHeadlineCheck,
} from "../headlineCheck";
import type { JevAnswer } from "../jev";

const input = {
  title: "Why Texas faces a growing flood threat this week",
  dek: null,
  contentSnippet: null,
  previewExcerpt: null,
  publishedAt: "2026-09-24T12:00:00Z",
};

function answers(
  supported: number,
  invented: number,
  publishable = 0.5,
): Record<string, JevAnswer> {
  return {
    supported: { type: "boolean", probability: supported },
    invented_attribution: { type: "boolean", probability: invented },
    publishable: { type: "boolean", probability: publishable },
  };
}

describe("buildHeadlineCheckState", () => {
  it("shows the model's own inputs, including the publication date", () => {
    const state = buildHeadlineCheckState(
      {
        ...input,
        dek: "Storms are stalling over the state.",
        contentSnippet: "Forecasters expect heavy rain.",
      },
      "Texas faces flood threat",
    );
    assert.equal(state.rewritten_headline, "Texas faces flood threat");
    assert.match(state.source_text ?? "", /^Original headline: Why Texas/);
    assert.match(state.source_text ?? "", /Published: September 24, 2026/);
    assert.match(state.source_text ?? "", /Summary: Storms are stalling/);
    assert.match(state.source_text ?? "", /Article excerpt: Forecasters/);
  });

  it("leaves out parts the model was not shown and caps the length", () => {
    const state = buildHeadlineCheckState(
      { ...input, publishedAt: null, contentSnippet: "x".repeat(9000) },
      "Headline",
    );
    assert.doesNotMatch(state.source_text ?? "", /Published:|Summary:/);
    assert.equal(state.source_text?.length, 6000);
  });
});

describe("parseHeadlineCheck", () => {
  it("reads the three probabilities", () => {
    assert.deepEqual(parseHeadlineCheck(answers(0.9, 0.1, 0.8)), {
      supportedP: 0.9,
      inventedAttributionP: 0.1,
      publishableP: 0.8,
    });
  });

  it("rejects a missing answer", () => {
    const partial = answers(0.9, 0.1);
    delete partial.invented_attribution;
    assert.throws(
      () => parseHeadlineCheck(partial),
      /missing_answer:invented_attribution/,
    );
  });
});

describe("isHeadlineFlagged", () => {
  it("flags a headline the model judges unsupported", () => {
    assert.equal(
      isHeadlineFlagged(parseHeadlineCheck(answers(0.2, 0.9))),
      true,
    );
    assert.equal(
      isHeadlineFlagged(parseHeadlineCheck(answers(0.5, 0.9))),
      false,
    );
    assert.equal(
      isHeadlineFlagged(parseHeadlineCheck(answers(0.9, 0.1))),
      false,
    );
  });
});

describe("checkHeadline", () => {
  it("asks all questions once, without retries", async () => {
    const seen: Array<{ questions: string[]; maxRetries?: number }> = [];
    const result = await checkHeadline(input, "NOAA warns of Texas flooding", {
      evaluateFn: async ({ questions, maxRetries }) => {
        seen.push({ questions: Object.keys(questions), maxRetries });
        return { answers: answers(0.1, 0.95), inputTokens: 420 };
      },
    });
    assert.deepEqual(seen, [
      {
        questions: Object.keys(HEADLINE_CHECK_QUESTIONS),
        maxRetries: 0,
      },
    ]);
    assert.equal(result.check.supportedP, 0.1);
    assert.equal(result.inputTokens, 420);
  });

  it("lets a failure reach the caller", async () => {
    await assert.rejects(
      checkHeadline(input, "Headline", {
        evaluateFn: async () => {
          throw new Error("Rate limit exceeded");
        },
      }),
      /Rate limit/,
    );
  });
});

describe("HeadlineCheckBreaker", () => {
  it("trips after consecutive failures and resets on success", () => {
    const breaker = new HeadlineCheckBreaker(2);
    breaker.recordError();
    assert.equal(breaker.tripped, false);
    breaker.recordSuccess();
    breaker.recordError();
    assert.equal(breaker.tripped, false);
    breaker.recordError();
    assert.equal(breaker.tripped, true);
  });
});
