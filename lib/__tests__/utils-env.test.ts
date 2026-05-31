import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseEnvInt, parseEnvFloat, webSearchBudgetExceeded } from "../utils";

const KEY = "__CLIMATE_RIVER_TEST_ENV__";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

describe("parseEnvInt", () => {
  it("returns the default when unset", () => {
    withEnv(undefined, () => assert.equal(parseEnvInt(KEY, 42), 42));
  });

  it("parses a valid integer", () => {
    withEnv("7", () => assert.equal(parseEnvInt(KEY, 42), 7));
  });

  it("truncates a float-looking value via parseInt", () => {
    withEnv("3.9", () => assert.equal(parseEnvInt(KEY, 42), 3));
  });

  it("falls back to the default on non-numeric input", () => {
    withEnv("not-a-number", () => assert.equal(parseEnvInt(KEY, 42), 42));
  });

  it("falls back to the default on empty string", () => {
    withEnv("", () => assert.equal(parseEnvInt(KEY, 42), 42));
  });

  it("parses negative integers", () => {
    withEnv("-5", () => assert.equal(parseEnvInt(KEY, 42), -5));
  });
});

describe("parseEnvFloat", () => {
  it("returns the default when unset", () => {
    withEnv(undefined, () => assert.equal(parseEnvFloat(KEY, 1.5), 1.5));
  });

  it("parses a valid float", () => {
    withEnv("2.5", () => assert.equal(parseEnvFloat(KEY, 1.5), 2.5));
  });

  it("parses an integer string as a float", () => {
    withEnv("3", () => assert.equal(parseEnvFloat(KEY, 1.5), 3));
  });

  it("falls back to the default on non-numeric input", () => {
    withEnv("abc", () => assert.equal(parseEnvFloat(KEY, 1.5), 1.5));
  });

  it("falls back to the default on empty string", () => {
    withEnv("", () => assert.equal(parseEnvFloat(KEY, 1.5), 1.5));
  });
});

describe("webSearchBudgetExceeded", () => {
  it("is false below the cap and true at/above it", () => {
    assert.equal(webSearchBudgetExceeded(0, 25), false);
    assert.equal(webSearchBudgetExceeded(24, 25), false);
    assert.equal(webSearchBudgetExceeded(25, 25), true);
    assert.equal(webSearchBudgetExceeded(26, 25), true);
  });

  it("treats a cap of 0 (or negative) as unlimited", () => {
    assert.equal(webSearchBudgetExceeded(1000, 0), false);
    assert.equal(webSearchBudgetExceeded(1000, -1), false);
  });
});
