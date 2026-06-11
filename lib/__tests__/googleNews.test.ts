import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBatchexecuteBody,
  decodeLegacyGoogleNewsToken,
  extractBatchParams,
  extractGoogleNewsToken,
  isAggregatorHost,
  isAggregatorUrl,
  parseBatchexecuteResponse,
  resolveGoogleNewsUrl,
} from "../googleNews";

describe("isAggregatorHost / isAggregatorUrl", () => {
  it("matches the aggregator hosts and subdomains", () => {
    assert.equal(isAggregatorHost("news.google.com"), true);
    assert.equal(isAggregatorHost("news.yahoo.com"), true);
    assert.equal(isAggregatorHost("www.msn.com"), true);
    assert.equal(isAggregatorHost("msn.com"), true);
  });
  it("does not match real publishers", () => {
    assert.equal(isAggregatorHost("theguardian.com"), false);
    assert.equal(isAggregatorHost("google.com"), false);
    assert.equal(isAggregatorHost("mynews.google.company.com"), false);
    assert.equal(isAggregatorUrl("https://www.reuters.com/article/x"), false);
  });
});

describe("extractGoogleNewsToken", () => {
  it("extracts from rss/articles and articles paths", () => {
    assert.equal(
      extractGoogleNewsToken(
        "https://news.google.com/rss/articles/ABC123?oc=5",
      ),
      "ABC123",
    );
    assert.equal(
      extractGoogleNewsToken("https://news.google.com/articles/XYZ_-9"),
      "XYZ_-9",
    );
  });
  it("returns null for non-GN URLs", () => {
    assert.equal(
      extractGoogleNewsToken("https://example.com/articles/A"),
      null,
    );
  });
});

describe("decodeLegacyGoogleNewsToken", () => {
  it("extracts an embedded URL from a legacy token", () => {
    const embedded = `\x08\x13"!https://example.com/some-article\xd2\x01\x00`;
    const token = Buffer.from(embedded, "latin1")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    assert.equal(
      decodeLegacyGoogleNewsToken(token),
      "https://example.com/some-article",
    );
  });
  it("returns null for opaque tokens with no embedded URL", () => {
    const token = Buffer.from([1, 2, 3, 4, 250, 251]).toString("base64");
    assert.equal(decodeLegacyGoogleNewsToken(token), null);
  });
  it("rejects an embedded URL that is itself an aggregator/GN link", () => {
    const embedded = `\x08\x13"https://news.google.com/foo\x00`;
    const token = Buffer.from(embedded, "latin1").toString("base64");
    assert.equal(decodeLegacyGoogleNewsToken(token), null);
  });
});

describe("extractBatchParams", () => {
  it("pulls signature and timestamp from the article page", () => {
    const html = `<c-wiz data-n-a-sg="AQzzz-sig" data-n-a-ts="1781000000" data-n-a-id="x">`;
    assert.deepEqual(extractBatchParams(html), {
      signature: "AQzzz-sig",
      timestamp: "1781000000",
    });
  });
  it("returns null when params are missing", () => {
    assert.equal(extractBatchParams("<html></html>"), null);
  });
});

describe("buildBatchexecuteBody / parseBatchexecuteResponse", () => {
  it("builds a form body containing the token, ts, and signature", () => {
    const body = buildBatchexecuteBody("TOK", "SIG", "123");
    assert.ok(body.startsWith("f.req="));
    const decoded = decodeURIComponent(body.slice("f.req=".length));
    assert.ok(decoded.includes("Fbv4je"));
    assert.ok(decoded.includes("TOK"));
    assert.ok(decoded.includes("SIG"));
    assert.ok(decoded.includes("123"));
  });

  it("parses the escaped garturlres payload", () => {
    const inner = JSON.stringify(["garturlres", "https://example.com/real", 1]);
    const outer = JSON.stringify([["wrb.fr", "Fbv4je", inner, null, null]]);
    const text = ")]}'\n\n12345\n" + outer + "\n";
    assert.equal(parseBatchexecuteResponse(text), "https://example.com/real");
  });

  it("returns null on garbage", () => {
    assert.equal(parseBatchexecuteResponse(")]}'\nnope"), null);
  });
});

describe("resolveGoogleNewsUrl", () => {
  it("passes through non-GN links without network calls", async () => {
    const res = await resolveGoogleNewsUrl("https://grist.org/some-story");
    assert.deepEqual(res, {
      url: "https://grist.org/some-story",
      method: "passthrough",
    });
  });
  it("uses the ?url= param when present", async () => {
    const res = await resolveGoogleNewsUrl(
      "https://news.google.com/rss/articles/x?url=https%3A%2F%2Fexample.com%2Fa",
    );
    assert.deepEqual(res, {
      url: "https://example.com/a",
      method: "url_param",
    });
  });
  it("resolves legacy tokens offline", async () => {
    const embedded = `\x08\x13"!https://example.com/some-article\x00`;
    const token = Buffer.from(embedded, "latin1")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await resolveGoogleNewsUrl(
      `https://news.google.com/rss/articles/${token}?oc=5`,
    );
    assert.equal(res.method, "legacy_token");
    assert.equal(res.url, "https://example.com/some-article");
  });
});
