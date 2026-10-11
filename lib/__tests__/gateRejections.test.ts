import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSampleRejection } from "../gateRejections";

const base = {
  enabled: true,
  recorded: 0,
  maxPerRun: 40,
  sampleRate: 0.2,
  roll: 0.1,
};

describe("shouldSampleRejection", () => {
  it("samples when the roll falls under the rate", () => {
    assert.equal(shouldSampleRejection(base), true);
    assert.equal(shouldSampleRejection({ ...base, roll: 0.2 }), false);
    assert.equal(shouldSampleRejection({ ...base, roll: 0.9 }), false);
  });

  it("never samples when the judge is disabled", () => {
    assert.equal(shouldSampleRejection({ ...base, enabled: false }), false);
  });

  it("stops at the per-run cap", () => {
    assert.equal(shouldSampleRejection({ ...base, recorded: 39 }), true);
    assert.equal(shouldSampleRejection({ ...base, recorded: 40 }), false);
  });

  it("samples nothing at a zero rate", () => {
    assert.equal(
      shouldSampleRejection({ ...base, sampleRate: 0, roll: 0 }),
      false,
    );
  });
});
