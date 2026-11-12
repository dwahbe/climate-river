import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseNumberFlag } from "../evalCli";

describe("parseNumberFlag", () => {
  it("reads the space-separated form", () => {
    assert.equal(parseNumberFlag(["--apply", "--limit", "200"], "limit"), 200);
  });

  it("reads the = form", () => {
    assert.equal(parseNumberFlag(["--days=7", "--apply"], "days"), 7);
  });

  it("returns undefined when the flag is absent", () => {
    assert.equal(parseNumberFlag(["--apply"], "limit"), undefined);
  });

  it("does not match a longer flag that starts the same way", () => {
    assert.equal(
      parseNumberFlag(["--limit-per-feed", "9"], "limit"),
      undefined,
    );
  });

  // A script must not quietly run with its default when the value is unusable:
  // `cleanup --days 90` once deleted at the 45-day default.
  it("throws on a missing or non-numeric value", () => {
    assert.throws(
      () => parseNumberFlag(["--limit", "--apply"], "limit"),
      /--limit needs a number/,
    );
    assert.throws(
      () => parseNumberFlag(["--days"], "days"),
      /--days needs a number/,
    );
    assert.throws(
      () => parseNumberFlag(["--days=soon"], "days"),
      /--days needs a number/,
    );
  });
});
