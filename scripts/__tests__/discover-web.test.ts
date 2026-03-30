import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rootDomain,
  isLikelyFabricatedUrl,
  parseWebSearchJson,
  filterUncitedResults,
} from "../discover-web";

describe("rootDomain", () => {
  it("returns two-part domains unchanged", () => {
    assert.equal(rootDomain("canarymedia.com"), "canarymedia.com");
    assert.equal(rootDomain("rmi.org"), "rmi.org");
  });

  it("strips subdomains to root domain", () => {
    assert.equal(rootDomain("assets.canarymedia.com"), "canarymedia.com");
    assert.equal(rootDomain("energy.canarymedia.com"), "canarymedia.com");
    assert.equal(rootDomain("pdf.wri.org"), "wri.org");
    assert.equal(rootDomain("publications.wri.org"), "wri.org");
    assert.equal(rootDomain("utilitytransitionhub.rmi.org"), "rmi.org");
  });

  it("strips deeply nested subdomains", () => {
    assert.equal(rootDomain("a.b.c.example.com"), "example.com");
  });

  it("handles compound TLDs correctly", () => {
    assert.equal(rootDomain("downtoearth.org.in"), "downtoearth.org.in");
    assert.equal(rootDomain("sub.downtoearth.org.in"), "downtoearth.org.in");
    assert.equal(rootDomain("bbc.co.uk"), "bbc.co.uk");
    assert.equal(rootDomain("news.bbc.co.uk"), "bbc.co.uk");
  });

  it("handles single-part input gracefully", () => {
    assert.equal(rootDomain("localhost"), "localhost");
  });
});

/* ------------------------------------------------------------------ */
/*  isLikelyFabricatedUrl                                              */
/* ------------------------------------------------------------------ */

describe("isLikelyFabricatedUrl", () => {
  it("detects trailing all-zero slug (the exact hallucination pattern)", () => {
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.politico.com/news/2026/03/28/biden-climate-agenda-gop-pushback-000000",
      ),
      true,
    );
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.politico.com/news/2026/03/22/epa-emission-standards-power-plants-000000",
      ),
      true,
    );
  });

  it("detects shorter zero-slugs (4+ zeros after dash)", () => {
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/article/title-0000"),
      true,
    );
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/article/slug-00000000"),
      true,
    );
  });

  it("detects path segment of all zeros (5+ zeros)", () => {
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/article/00000000"),
      true,
    );
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/article/00000/details"),
      true,
    );
  });

  it("allows legitimate Politico article IDs", () => {
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.politico.com/news/2026/03/28/biden-climate-00382947",
      ),
      false,
    );
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.politico.com/news/2025/12/01/energy-transition-report-00198234",
      ),
      false,
    );
  });

  it("allows NYT video IDs that contain embedded zeros", () => {
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.nytimes.com/video/climate/100000010734830/how-a-melting-glacier-could-affect-millions.html",
      ),
      false,
    );
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.nytimes.com/video/climate/100000010684396/thwaites-glacier-antarctica-research.html",
      ),
      false,
    );
  });

  it("allows URLs with short zero runs below threshold", () => {
    // 3 zeros after dash — below the 4-zero threshold
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/section-000/page"),
      false,
    );
    // 4 zeros as standalone segment — below the 5-zero segment threshold
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/article/0000"),
      false,
    );
  });

  it("returns false for malformed or empty URLs", () => {
    assert.equal(isLikelyFabricatedUrl(""), false);
    assert.equal(isLikelyFabricatedUrl("not-a-url"), false);
  });

  it("ignores zeros in query strings (only checks pathname)", () => {
    assert.equal(
      isLikelyFabricatedUrl("https://example.com/article?id=000000"),
      false,
    );
    assert.equal(
      isLikelyFabricatedUrl(
        "https://example.com/real-article-123?tracking=000000",
      ),
      false,
    );
  });

  it("allows typical news article URLs", () => {
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.reuters.com/business/energy/coal-power-use-hits-record-2025-12-01/",
      ),
      false,
    );
    assert.equal(
      isLikelyFabricatedUrl(
        "https://www.theguardian.com/environment/2026/mar/15/climate-targets-report",
      ),
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  parseWebSearchJson                                                 */
/* ------------------------------------------------------------------ */

describe("parseWebSearchJson", () => {
  it("passes through legitimate articles", () => {
    const json = JSON.stringify([
      {
        title: "Global Climate Summit Sets New Carbon Reduction Targets",
        url: "https://reuters.com/climate/summit-carbon-targets-2026",
        snippet: "World leaders agreed on new targets",
        publishedDate: "2026-03-28T12:00:00Z",
        source: "Reuters",
      },
      {
        title: "EPA Finalizes New Methane Rules for Oil and Gas Industry",
        url: "https://apnews.com/article/epa-methane-rules-oil-gas-12345",
        snippet: "The EPA announced final methane regulations",
        publishedDate: "2026-03-27T09:00:00Z",
        source: "AP News",
      },
    ]);

    const results = parseWebSearchJson(json, "climate news");
    assert.equal(results.length, 2);
    assert.equal(
      results[0].title,
      "Global Climate Summit Sets New Carbon Reduction Targets",
    );
    assert.equal(
      results[1].url,
      "https://apnews.com/article/epa-methane-rules-oil-gas-12345",
    );
  });

  it("filters out articles with fabricated zero-slug URLs", () => {
    const json = JSON.stringify([
      {
        title: "Real Article About Climate Change Policy Updates",
        url: "https://politico.com/news/2026/03/28/climate-policy-00382947",
        snippet: "A real article",
        publishedDate: "2026-03-28T12:00:00Z",
        source: "Politico",
      },
      {
        title: "Biden Climate Agenda Faces New Hurdles From Opposition",
        url: "https://politico.com/news/2026/03/28/biden-climate-agenda-000000",
        snippet: "A fabricated article",
        publishedDate: "2026-03-28T10:00:00Z",
        source: "Politico",
      },
      {
        title: "EPA Proposes Stricter Emission Standards For Power Plants",
        url: "https://politico.com/news/2026/03/27/epa-emission-standards-000000",
        snippet: "Another fabricated article",
        publishedDate: "2026-03-27T14:30:00Z",
        source: "Politico",
      },
    ]);

    const results = parseWebSearchJson(json, "politico climate");
    assert.equal(results.length, 1);
    assert.equal(
      results[0].url,
      "https://politico.com/news/2026/03/28/climate-policy-00382947",
    );
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepEqual(parseWebSearchJson("not json at all", "query"), []);
    assert.deepEqual(parseWebSearchJson("{}", "query"), []);
  });

  it("returns empty array for null/undefined input", () => {
    assert.deepEqual(parseWebSearchJson(null, "query"), []);
    assert.deepEqual(parseWebSearchJson(undefined, "query"), []);
  });

  it("handles fenced code block JSON", () => {
    const input =
      '```json\n[{"title":"Global Carbon Markets See Record Trading Volume","url":"https://reuters.com/markets/carbon-trading-2026","snippet":"Carbon markets hit new highs","publishedDate":"2026-03-28T12:00:00Z"}]\n```';
    const results = parseWebSearchJson(input, "climate");
    assert.equal(results.length, 1);
    assert.equal(
      results[0].title,
      "Global Carbon Markets See Record Trading Volume",
    );
  });

  it("rejects items missing title or url", () => {
    const json = JSON.stringify([
      {
        title: "Valid Article With Both Title And URL Present",
        url: "https://example.com/article",
        snippet: "A snippet",
      },
      { title: "", url: "https://example.com/no-title", snippet: "No title" },
      {
        title: "Article Without Any URL Field Present",
        url: "",
        snippet: "No url",
      },
    ]);
    const results = parseWebSearchJson(json, "test");
    assert.equal(results.length, 1);
    assert.equal(
      results[0].title,
      "Valid Article With Both Title And URL Present",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  filterUncitedResults                                               */
/* ------------------------------------------------------------------ */

describe("filterUncitedResults", () => {
  it("keeps results whose hostname appears in sources", () => {
    const results = [
      {
        title: "Climate Article",
        url: "https://reuters.com/article/climate-123",
        snippet: "A snippet",
      },
    ];
    const sources = [{ url: "https://reuters.com/article/climate-456" }];
    const filtered = filterUncitedResults(results, sources);
    assert.equal(filtered.length, 1);
  });

  it("drops results whose hostname does not appear in any source", () => {
    const results = [
      {
        title: "Fabricated Article",
        url: "https://fabricated-outlet.com/story-1",
        snippet: "A snippet",
      },
    ];
    const sources = [{ url: "https://reuters.com/article/xyz" }];
    const filtered = filterUncitedResults(results, sources);
    assert.equal(filtered.length, 0);
  });

  it("normalizes www prefix on both sides", () => {
    const results = [
      {
        title: "NYT Article",
        url: "https://www.nytimes.com/2026/03/28/climate/article.html",
        snippet: "A snippet",
      },
    ];
    const sources = [{ url: "https://nytimes.com/2026/03/28/other.html" }];
    const filtered = filterUncitedResults(results, sources);
    assert.equal(filtered.length, 1);
  });

  it("returns all results when sources array is empty", () => {
    const results = [
      {
        title: "Article One",
        url: "https://example.com/1",
        snippet: "Snippet",
      },
      {
        title: "Article Two",
        url: "https://other.com/2",
        snippet: "Snippet",
      },
    ];
    const filtered = filterUncitedResults(results, []);
    assert.equal(filtered.length, 2);
  });

  it("handles malformed source URLs gracefully", () => {
    const results = [
      {
        title: "Reuters Article",
        url: "https://reuters.com/article/1",
        snippet: "A snippet",
      },
    ];
    const sources = [
      { url: "not-a-url" },
      { url: "https://reuters.com/other" },
    ];
    const filtered = filterUncitedResults(results, sources);
    assert.equal(filtered.length, 1);
  });

  it("drops results with malformed URLs", () => {
    const results = [
      { title: "Bad URL", url: "not-a-url", snippet: "A snippet" },
    ];
    const sources = [{ url: "https://reuters.com/article" }];
    const filtered = filterUncitedResults(results, sources);
    assert.equal(filtered.length, 0);
  });

  it("keeps cited and drops uncited in mixed results", () => {
    const results = [
      {
        title: "Reuters Climate Report",
        url: "https://reuters.com/climate/report",
        snippet: "A snippet",
      },
      {
        title: "Fabricated Outlet Story",
        url: "https://fabricated-news.com/story",
        snippet: "A snippet",
      },
      {
        title: "NYT Climate Analysis",
        url: "https://www.nytimes.com/climate/analysis",
        snippet: "A snippet",
      },
    ];
    const sources = [
      { url: "https://reuters.com/search" },
      { url: "https://www.nytimes.com/section/climate" },
    ];
    const filtered = filterUncitedResults(results, sources);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].url, "https://reuters.com/climate/report");
    assert.equal(filtered[1].url, "https://www.nytimes.com/climate/analysis");
  });
});
