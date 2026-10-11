import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeBreaches, type HealthMetrics } from "../health-report";

function healthy(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    articlesIngested24h: 300,
    cronErrors24h: 0,
    rewrite: {
      attempts: 500,
      llmErrors: 0,
      accepted: 400,
      fallbackAttempts: 0,
      llmErrorShare: 0,
      acceptShare: 0.8,
      fallbackShare: 0,
    },
    prefetch: { attempted: 200, success: 150, successShare: 0.75 },
    discovery: {
      searches: 100,
      successes: 100,
      successShare: 1,
      candidates: 400,
      accepted: 40,
      acceptShare: 0.1,
      exaSpendMonthUsd: 2,
    },
    judge: { enabled: false, judged24h: 0, errors24h: 0, errorShare: null },
    unresolvedGnShare24h: 0.1,
    unembeddedShare24h: 0,
    scoresStaleMinutes: 5,
    unrewrittenLeads7d: 10,
    hiddenAggregatorLeadShare72h: 0.1,
    singletonShare: 0.5,
    ...overrides,
  };
}

describe("computeBreaches", () => {
  it("is empty for a healthy pipeline", () => {
    assert.deepEqual(computeBreaches(healthy()), []);
  });

  it("flags rewrites answered by the fallback model above 25%", () => {
    const m = healthy({
      rewrite: {
        ...healthy().rewrite,
        fallbackAttempts: 150,
        fallbackShare: 0.3,
      },
    });
    assert.deepEqual(computeBreaches(m), ["rewrite_fallback_share:0.30"]);
  });

  it("ignores the fallback share under the 20-attempt minimum", () => {
    const m = healthy({
      rewrite: {
        ...healthy().rewrite,
        attempts: 10,
        fallbackAttempts: 5,
        fallbackShare: 0.5,
      },
    });
    assert.deepEqual(computeBreaches(m), []);
  });

  it("flags articles ingested without an embedding above 5%", () => {
    assert.deepEqual(computeBreaches(healthy({ unembeddedShare24h: 0.1 })), [
      "unembedded_share_24h:0.10",
    ]);
  });

  it("ignores the unembedded share under the 20-article minimum", () => {
    const m = healthy({ articlesIngested24h: 10, unembeddedShare24h: 0.5 });
    assert.deepEqual(computeBreaches(m), []);
  });

  it("keeps the pre-existing guards", () => {
    assert.deepEqual(computeBreaches(healthy({ articlesIngested24h: 0 })), [
      "no_articles_ingested_24h",
    ]);
    assert.deepEqual(computeBreaches(healthy({ unresolvedGnShare24h: 0.51 })), [
      "unresolved_gn_share_24h:0.51",
    ]);
  });
});
