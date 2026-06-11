import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LlmCircuitBreaker, buildFailedNotes } from "../rewrite";

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
