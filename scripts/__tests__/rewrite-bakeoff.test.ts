import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBlindedReviewRows,
  estimateCostUsd,
  parseCsv,
  stringifyCsv,
  summarizeHumanReview,
  type BakeoffResultRecord,
} from "../rewrite-bakeoff";

function record(overrides: Partial<BakeoffResultRecord>): BakeoffResultRecord {
  return {
    articleId: 42,
    sourceName: "Climate Wire",
    canonicalUrl: "https://example.com/story",
    publishedAt: "2026-03-17T12:00:00Z",
    clusterScore: 12.5,
    contentStatus: "success",
    originalTitle: "Original title",
    dek: "Original dek",
    contentNote: "",
    profileId: "structured-gpt-4.1-mini",
    provider: "openai",
    model: "gpt-4.1-mini",
    promptVariant: "structured",
    success: true,
    retryUsed: false,
    finalDraft: "EPA says utilities must cut power plant emissions 80% by 2032",
    firstDraft: "EPA says utilities must cut power plant emissions 80% by 2032",
    retryDraft: null,
    firstFailureCode: null,
    retryFailureCode: null,
    finalFailureCode: null,
    latencyMs: 1200,
    inputTokens: 1000,
    outputTokens: 40,
    totalTokens: 1040,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    estimatedCostUsd: 0.000464,
    ...overrides,
  };
}

describe("estimateCostUsd", () => {
  it("uses the configured gpt-4.1-mini prices", () => {
    const cost = estimateCostUsd("gpt-4.1-mini", {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
    });
    assert.equal(cost?.toFixed(6), "0.000560");
  });

  it("returns null for unknown model", () => {
    assert.equal(
      estimateCostUsd("unknown-model", {
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
      }),
      null,
    );
  });

  it("returns null without token usage", () => {
    assert.equal(estimateCostUsd("gpt-4.1-mini"), null);
  });
});

describe("review artifact helpers", () => {
  it("builds deterministic blinded rows from two profiles", () => {
    const rows = [
      record({
        articleId: 42,
        profileId: "profile-a",
        finalDraft: "EPA says utilities must cut emissions 80% by 2032",
      }),
      record({
        articleId: 42,
        profileId: "profile-b",
        finalDraft:
          "EPA finalizes rule requiring utilities to cut emissions 80% by 2032",
      }),
    ];

    const review = buildBlindedReviewRows(rows, "profile-a", "profile-b");
    assert.equal(review.rows.length, 1);
    assert.equal(review.blindKey.length, 1);
    assert.ok(
      [review.blindKey[0].candidateA, review.blindKey[0].candidateB].includes(
        "profile-a",
      ),
    );
    assert.ok(
      [review.blindKey[0].candidateA, review.blindKey[0].candidateB].includes(
        "profile-b",
      ),
    );
  });

  it("round-trips csv content with commas and quotes", () => {
    const csv = stringifyCsv(
      [
        {
          article_id: "1",
          notes: 'Quoted, "comma-heavy" note',
        },
      ],
      ["article_id", "notes"],
    );
    const parsed = parseCsv(csv);
    assert.equal(parsed[0].article_id, "1");
    assert.equal(parsed[0].notes, 'Quoted, "comma-heavy" note');
  });

  it("summarizes wins and accuracy failures using the blind key", () => {
    const summary = summarizeHumanReview(
      [
        {
          article_id: "42",
          winner: "B",
          accuracy_a: "fail",
          accuracy_b: "pass",
        },
      ],
      [
        {
          articleId: 42,
          candidateA: "profile-a",
          candidateB: "profile-b",
        },
      ],
    );

    assert.equal(summary.scored, 1);
    assert.equal(summary.wins.get("profile-b"), 1);
    assert.equal(summary.accuracyFails.get("profile-a"), 1);
  });
});
