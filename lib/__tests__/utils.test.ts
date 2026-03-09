import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonical,
  mapLimit,
  cleanGoogleNewsTitle,
  isValidArticleDate,
} from "../utils";

describe("canonical", () => {
  it("strips utm params", () => {
    const url =
      "https://example.com/article?utm_source=twitter&utm_medium=social&id=123";
    const result = canonical(url);
    assert.ok(!result.includes("utm_source"));
    assert.ok(!result.includes("utm_medium"));
    assert.ok(result.includes("id=123"));
  });

  it("strips fbclid and gclid", () => {
    const url = "https://example.com/page?fbclid=abc123&gclid=xyz456&ref=home";
    const result = canonical(url);
    assert.ok(!result.includes("fbclid"));
    assert.ok(!result.includes("gclid"));
    assert.ok(result.includes("ref=home"));
  });

  it("strips Google-specific tracking params (ved, usg, oc, si)", () => {
    const url =
      "https://example.com/article?ved=abc&usg=def&oc=1&si=xyz&page=2";
    const result = canonical(url);
    assert.ok(!result.includes("ved="));
    assert.ok(!result.includes("usg="));
    assert.ok(!result.includes("oc="));
    assert.ok(!result.includes("si="));
    assert.ok(result.includes("page=2"));
  });

  it("strips hash fragment", () => {
    const url = "https://example.com/article#section-2";
    const result = canonical(url);
    assert.ok(!result.includes("#section-2"));
  });

  it("returns original on invalid URL", () => {
    assert.equal(canonical("not-a-url"), "not-a-url");
  });

  it("preserves non-tracking params", () => {
    const url = "https://example.com/search?q=climate&page=2";
    const result = canonical(url);
    assert.ok(result.includes("q=climate"));
    assert.ok(result.includes("page=2"));
  });
});

describe("mapLimit", () => {
  it("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapLimit(items, 2, async (n) => n * 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  it("maintains insertion order", async () => {
    const items = [50, 10, 30, 20, 40];
    const results = await mapLimit(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    assert.deepEqual(results, [50, 10, 30, 20, 40]);
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await mapLimit(items, 2, async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
    });
    assert.ok(maxConcurrent <= 2, `max concurrent was ${maxConcurrent}`);
  });

  it("handles empty array", async () => {
    const results = await mapLimit([], 5, async (n: number) => n);
    assert.deepEqual(results, []);
  });

  it("propagates errors", async () => {
    await assert.rejects(
      () =>
        mapLimit([1, 2, 3], 2, async (n) => {
          if (n === 2) throw new Error("fail");
          return n;
        }),
      { message: "fail" },
    );
  });
});

describe("cleanGoogleNewsTitle", () => {
  it("removes trailing ' - Source Name' with hyphen", () => {
    assert.equal(
      cleanGoogleNewsTitle("Climate Bill Passes - Reuters"),
      "Climate Bill Passes",
    );
  });

  it("removes trailing ' — Source Name' with em-dash", () => {
    assert.equal(
      cleanGoogleNewsTitle("Climate Bill Passes — Reuters"),
      "Climate Bill Passes",
    );
  });

  it("preserves titles without source suffix", () => {
    assert.equal(
      cleanGoogleNewsTitle("Climate Bill Passes Congress"),
      "Climate Bill Passes Congress",
    );
  });

  it("handles hyphens mid-title correctly", () => {
    assert.equal(
      cleanGoogleNewsTitle("US-China Climate Deal - The Guardian"),
      "US-China Climate Deal",
    );
  });

  it("trims whitespace", () => {
    assert.equal(
      cleanGoogleNewsTitle("  Climate Bill  - Reuters  "),
      "Climate Bill",
    );
  });
});

describe("isValidArticleDate", () => {
  it("rejects null dates", () => {
    const result = isValidArticleDate(null);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "missing date");
  });

  it("accepts recent dates", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    assert.equal(isValidArticleDate(twoDaysAgo).valid, true);
  });

  it("rejects future dates", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = isValidArticleDate(tomorrow);
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("future"));
  });

  it("rejects dates older than default 30 days", () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const result = isValidArticleDate(sixtyDaysAgo);
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("too old"));
  });

  it("respects custom maxAgeDays", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    assert.equal(isValidArticleDate(tenDaysAgo, 30).valid, true);
    assert.equal(isValidArticleDate(tenDaysAgo, 7).valid, false);
  });

  it("rejects dates suspiciously close to now", () => {
    const justNow = new Date(Date.now() - 5 * 1000);
    const result = isValidArticleDate(justNow);
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("suspiciously close"));
  });
});
