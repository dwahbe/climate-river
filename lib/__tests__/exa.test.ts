import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildExaSearchBody,
  mapExaSearchResults,
  exaSearch,
  looksLikeSectionPath,
} from "../exa";

describe("buildExaSearchBody", () => {
  it("never requests contents and clamps numResults", () => {
    const body = buildExaSearchBody({
      query: "q",
      includeDomains: ["reuters.com"],
      startPublishedDate: "2026-08-20T00:00:00.000Z",
      numResults: 500,
      category: "news",
    });
    assert.equal("contents" in body, false);
    assert.equal(body.numResults, 100);
    assert.equal(body.type, "auto");
    assert.equal(body.category, "news");
    assert.deepEqual(body.includeDomains, ["reuters.com"]);
    assert.equal(body.startPublishedDate, "2026-08-20T00:00:00.000Z");
  });
  it("omits empty optional fields", () => {
    const body = buildExaSearchBody({ query: "q", category: null });
    assert.deepEqual(Object.keys(body).sort(), ["numResults", "query", "type"]);
  });
});

describe("mapExaSearchResults", () => {
  const response = {
    results: [
      {
        title: "Reuters: heat wave grips Spain",
        url: "https://www.reuters.com/world/europe/heat-2026-08-21/",
        publishedDate: "2026-08-21T00:00:00.000Z",
      },
      {
        title: "Climate | Reuters",
        url: "https://www.reuters.com/sustainability/climate-energy/",
      },
      {
        title: "Off-domain",
        url: "https://www.bloomberg.com/news/articles/2026-08-21/x",
      },
      { title: "  ", url: "https://www.reuters.com/world/y" },
      {
        title: "Subdomain ok",
        url: "https://graphics.reuters.com/CLIMATE-CHANGE/ARCTIC-SEA-ICE/",
      },
      { title: "bad url", url: "not a url" },
    ],
    costDollars: { total: 0.007 },
  };
  it("keeps in-domain URLs (incl. short two-segment paths), drops off-domain / untitled", () => {
    const mapped = mapExaSearchResults(response, ["reuters.com"]);
    assert.deepEqual(
      mapped.map((m) => m.url),
      [
        "https://www.reuters.com/world/europe/heat-2026-08-21/",
        "https://www.reuters.com/sustainability/climate-energy/",
        "https://graphics.reuters.com/CLIMATE-CHANGE/ARCTIC-SEA-ICE/",
      ],
    );
    assert.equal(mapped[0].host, "reuters.com");
    assert.equal(mapped[0].publishedDate, "2026-08-21T00:00:00.000Z");
  });
  it("without includeDomains keeps every domain", () => {
    assert.equal(mapExaSearchResults(response).length, 4);
  });
});

describe("exaSearch", () => {
  it("posts the body with the api key and returns mapped results + cost", async () => {
    const seen: { call?: { url: string; init: RequestInit } } = {};
    const fakeFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.call = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          requestId: "r1",
          results: [
            {
              title: "A",
              url: "https://apnews.com/article/heat-wave-europe-abc123def456",
            },
          ],
          costDollars: { total: 0.007 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const out = await exaSearch(
      { query: "climate", includeDomains: ["apnews.com"], category: "news" },
      "test-key",
      fakeFetch,
    );
    assert.equal(out.results.length, 1);
    assert.equal(out.costUsd, 0.007);
    assert.equal(out.requestId, "r1");
    assert.ok(seen.call);
    const headers = seen.call.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "test-key");
    const body = JSON.parse(String(seen.call.init.body));
    assert.equal(body.category, "news");
    assert.equal("contents" in body, false);
  });
  it("throws on non-2xx so callers log a provider error", async () => {
    const fakeFetch = (async () =>
      new Response("quota", { status: 429 })) as typeof fetch;
    await assert.rejects(
      () => exaSearch({ query: "q" }, "k", fakeFetch),
      /Exa HTTP 429/,
    );
  });
});

describe("looksLikeSectionPath", () => {
  it("flags the root, single short segments and listing prefixes", () => {
    for (const p of [
      "/",
      "/climate",
      "/climate/",
      "/topics/climate-change/",
      "/tag/energy",
      "/authors/jane-doe",
    ]) {
      assert.equal(looksLikeSectionPath(p), true, p);
    }
  });
  it("keeps article-shaped paths, including short two-segment slugs", () => {
    for (const p of [
      "/world/europe/heat-2026-08-21/",
      "/energy/utah-solar-power-coal-generation/",
      "/qa-what-the-uk-carbon-budget-means",
      "/news/articles/2026-08-21/x",
      "/environment/2026/aug/21/slug",
      "/news/world-energy-outlook-2026",
      "/insights/why-utilities-cannot-innovate",
      "/news/wedges",
      "/investigations/carbon-captured",
      "/insights/electrification-explained",
      "/sustainability/climate-energy/",
      "/news/environment",
    ]) {
      assert.equal(looksLikeSectionPath(p), false, p);
    }
  });
});
