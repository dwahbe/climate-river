import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRssXml, loadFeedClusters } from "../feedService";
import type { Cluster } from "../../models/cluster";

const cluster: Cluster = {
  cluster_id: 42,
  lead_article_id: 101,
  lead_title: 'EPA & states <clash> over "clean" power rule',
  lead_was_rewritten: false,
  lead_url: "https://example.com/lead?a=1&b=2",
  lead_dek: null,
  lead_source: "Example Source",
  lead_homepage: "https://example.com",
  lead_author: null,
  published_at: "2026-11-11T12:00:00Z",
  size: 3,
  score: 1,
  sources_count: 3,
  subs: [],
  subs_total: 0,
  all_articles_by_source: {},
  lead_content_status: null,
  lead_content_word_count: null,
  lead_image: null,
};

/** A fetcher that plays back one result (or error) per call. */
function sequence(...results: Array<Cluster[] | Error>) {
  let calls = 0;
  const fetchClusters = async () => {
    const result = results[Math.min(calls, results.length - 1)];
    calls++;
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetchClusters, calls: () => calls };
}

describe("loadFeedClusters", () => {
  // The feed once caught this error and rendered an empty feed, which was then
  // cached for five minutes. It has to reject so ISR keeps the last good feed.
  it("rejects when the query fails at runtime", async () => {
    const { fetchClusters, calls } = sequence(new Error("statement timeout"));
    await assert.rejects(
      loadFeedClusters({ fetchClusters, isBuild: false, retryDelayMs: 0 }),
      /statement timeout/,
    );
    assert.equal(calls(), 1);
  });

  it("accepts an empty result at runtime without retrying", async () => {
    const { fetchClusters, calls } = sequence([]);
    const result = await loadFeedClusters({
      fetchClusters,
      isBuild: false,
      retryDelayMs: 0,
    });
    assert.deepEqual(result, []);
    assert.equal(calls(), 1);
  });

  // During the build getRiverData turns a failed query into [], so an empty
  // result there is retried rather than baked into the deployment.
  it("retries an empty result during the build", async () => {
    const { fetchClusters, calls } = sequence([], [cluster]);
    const result = await loadFeedClusters({
      fetchClusters,
      isBuild: true,
      retryDelayMs: 0,
    });
    assert.equal(result.length, 1);
    assert.equal(calls(), 2);
  });

  it("gives up after two build retries", async () => {
    const { fetchClusters, calls } = sequence([]);
    const result = await loadFeedClusters({
      fetchClusters,
      isBuild: true,
      retryDelayMs: 0,
    });
    assert.deepEqual(result, []);
    assert.equal(calls(), 3);
  });
});

describe("buildRssXml", () => {
  const xml = buildRssXml([cluster], new Date("2026-11-12T00:00:00Z"));

  it("renders one item per cluster with a permalink", () => {
    assert.equal(xml.match(/<item>/g)?.length, 1);
    assert.ok(xml.includes("<link>https://climateriver.org/river/42</link>"));
    assert.ok(
      xml.includes(
        "<lastBuildDate>Thu, 12 Nov 2026 00:00:00 GMT</lastBuildDate>",
      ),
    );
  });

  it("escapes XML in titles and source URLs", () => {
    assert.ok(
      xml.includes(
        "<title>EPA &amp; states &lt;clash&gt; over &quot;clean&quot; power rule</title>",
      ),
    );
    assert.ok(!xml.includes("<clash>"));
  });

  it("falls back to a source count when there is no dek", () => {
    assert.ok(
      xml.includes("<description>Coverage from 3 sources</description>"),
    );
  });
});
