import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WELL_KNOWN_FEED_PATHS,
  extractFeedLinks,
  feedCandidateUrls,
  isFreshFeed,
} from "../discover-feeds";

describe("extractFeedLinks", () => {
  it("extracts RSS and Atom alternate links, resolving relative hrefs", () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS">
        <link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
        <link rel="stylesheet" href="/style.css">
        <link rel="alternate" type="text/html" href="/mobile">
      </head></html>`;
    const links = extractFeedLinks(html, "https://example.com/news/page");
    assert.deepEqual(links, [
      "https://example.com/feed.xml",
      "https://example.com/atom.xml",
    ]);
  });

  it("handles attribute order variations and single quotes", () => {
    const html = `<link href='/rss' type='application/rss+xml' rel='alternate'/>`;
    assert.deepEqual(extractFeedLinks(html, "https://example.com"), [
      "https://example.com/rss",
    ]);
  });

  it("returns empty for pages without feed links", () => {
    assert.deepEqual(
      extractFeedLinks("<html><body>hi</body></html>", "https://example.com"),
      [],
    );
  });

  it("skips unresolvable hrefs instead of throwing", () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="https://[bad">`;
    assert.deepEqual(extractFeedLinks(html, "https://example.com"), []);
  });
});

describe("feedCandidateUrls", () => {
  it("puts homepage-declared feeds before well-known paths and dedupes", () => {
    const candidates = feedCandidateUrls("https://example.com", [
      "https://example.com/custom/feed",
      "https://example.com/feed", // duplicates a well-known path
    ]);
    assert.equal(candidates[0], "https://example.com/custom/feed");
    assert.equal(candidates[1], "https://example.com/feed");
    // the well-known /feed must not appear twice
    assert.equal(
      candidates.filter((u) => u === "https://example.com/feed").length,
      1,
    );
  });

  it("caps the candidate list", () => {
    const candidates = feedCandidateUrls("https://example.com", []);
    assert.ok(candidates.length <= WELL_KNOWN_FEED_PATHS.length);
    assert.ok(candidates.length > 0);
  });

  it("drops non-http(s) URLs", () => {
    const candidates = feedCandidateUrls("https://example.com", [
      "ftp://example.com/feed",
      "javascript:alert(1)",
    ]);
    assert.ok(candidates.every((u) => /^https?:/.test(u)));
  });
});

describe("isFreshFeed", () => {
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

  it("accepts a feed with a recent item", () => {
    assert.equal(
      isFreshFeed([{ isoDate: daysAgo(40) }, { isoDate: daysAgo(2) }], 30),
      true,
    );
  });

  it("rejects a feed whose newest item is too old", () => {
    assert.equal(isFreshFeed([{ isoDate: daysAgo(45) }], 30), false);
  });

  it("rejects items with missing or unparseable dates", () => {
    assert.equal(isFreshFeed([{}, { pubDate: "not a date" }], 30), false);
  });

  it("rejects far-future-dated items (broken feeds)", () => {
    assert.equal(isFreshFeed([{ isoDate: daysAgo(-10) }], 30), false);
  });
});
