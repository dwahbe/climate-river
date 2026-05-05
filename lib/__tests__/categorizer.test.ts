import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterStorableCategoryScores,
  rankHybridCategoryScores,
} from "../categorizer";

describe("rankHybridCategoryScores", () => {
  it("uses semantic support to break strong rule ties", () => {
    const [primary] = rankHybridCategoryScores([
      {
        slug: "justice",
        confidence: 0.49,
        ruleConfidence: 0.7,
        reasons: [],
      },
      {
        slug: "impacts",
        confidence: 0.501,
        ruleConfidence: 0.7,
        reasons: [],
      },
    ]);

    assert.equal(primary.slug, "impacts");
  });

  it("keeps concrete rule matches ahead of semantic-only guesses", () => {
    const [primary] = rankHybridCategoryScores([
      {
        slug: "impacts",
        confidence: 0.51,
        ruleConfidence: 0,
        reasons: [],
      },
      {
        slug: "tech",
        confidence: 0.46,
        ruleConfidence: 0.4,
        reasons: [],
      },
    ]);

    assert.equal(primary.slug, "tech");
  });
});

describe("filterStorableCategoryScores", () => {
  it("drops weak semantic-only scores before storage", () => {
    const scores = filterStorableCategoryScores([
      {
        slug: "justice",
        confidence: 0.49,
        ruleConfidence: 0,
        semanticConfidence: 0.82,
        confidenceSource: "semantic",
        reasons: ["Semantic similarity: 0.817"],
      },
      {
        slug: "impacts",
        confidence: 0.4,
        ruleConfidence: 0.4,
        semanticConfidence: 0,
        confidenceSource: "rule",
        reasons: ["pattern: flood"],
      },
    ]);

    assert.deepEqual(
      scores.map((score) => score.slug),
      ["impacts"],
    );
  });

  it("refuses to store low-confidence primary labels", () => {
    const scores = filterStorableCategoryScores([
      {
        slug: "business",
        confidence: 0.263,
        ruleConfidence: 0.263,
        semanticConfidence: 0,
        confidenceSource: "rule",
        reasons: ["keyword: market"],
      },
    ]);

    assert.deepEqual(scores, []);
  });

  it("allows high-margin semantic-only scores when they are clearly separated", () => {
    const scores = filterStorableCategoryScores([
      {
        slug: "research",
        confidence: 0.82,
        ruleConfidence: 0,
        semanticConfidence: 0.82,
        confidenceSource: "semantic",
        reasons: ["Semantic similarity: 0.820"],
      },
      {
        slug: "impacts",
        confidence: 0.66,
        ruleConfidence: 0,
        semanticConfidence: 0.66,
        confidenceSource: "semantic",
        reasons: ["Semantic similarity: 0.660"],
      },
    ]);

    assert.deepEqual(
      scores.map((score) => score.slug),
      ["research", "impacts"],
    );
  });

  it("drops ambiguous semantic-only primaries without a clear margin", () => {
    const scores = filterStorableCategoryScores([
      {
        slug: "research",
        confidence: 0.72,
        ruleConfidence: 0,
        semanticConfidence: 0.72,
        confidenceSource: "semantic",
        reasons: ["Semantic similarity: 0.720"],
      },
      {
        slug: "impacts",
        confidence: 0.66,
        ruleConfidence: 0,
        semanticConfidence: 0.66,
        confidenceSource: "semantic",
        reasons: ["Semantic similarity: 0.660"],
      },
    ]);

    assert.deepEqual(scores, []);
  });
});
