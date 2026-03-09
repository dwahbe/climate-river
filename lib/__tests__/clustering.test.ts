import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSimilarity,
  computeCentroid,
  agglomerativeCluster,
  CLUSTER_CONFIG,
} from "../clustering";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 0, 0, 1];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-10);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-10);
  });

  it("returns correct value for known vectors", () => {
    // [1,2,3]·[4,5,6] = 32, |a|=√14, |b|=√77 → 32/√1078 ≈ 0.9746
    const sim = cosineSimilarity([1, 2, 3], [4, 5, 6]);
    assert.ok(Math.abs(sim - 0.9746) < 0.001);
  });

  it("returns 0 for zero vectors", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe("computeCentroid", () => {
  it("returns empty for empty input", () => {
    assert.deepEqual(computeCentroid([]), []);
  });

  it("returns the vector itself for single input", () => {
    const v = [1, 2, 3];
    const centroid = computeCentroid([v]);
    assert.equal(centroid.length, 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(centroid[i] - v[i]) < 1e-10);
    }
  });

  it("averages vectors correctly", () => {
    const result = computeCentroid([
      [2, 4],
      [4, 8],
    ]);
    assert.ok(Math.abs(result[0] - 3) < 1e-10);
    assert.ok(Math.abs(result[1] - 6) < 1e-10);
  });

  it("averages three vectors", () => {
    const result = computeCentroid([
      [3, 0, 0],
      [0, 3, 0],
      [0, 0, 3],
    ]);
    assert.ok(Math.abs(result[0] - 1) < 1e-10);
    assert.ok(Math.abs(result[1] - 1) < 1e-10);
    assert.ok(Math.abs(result[2] - 1) < 1e-10);
  });
});

describe("agglomerativeCluster", () => {
  it("keeps highly similar articles together", () => {
    const articles = [
      { article_id: 1, embedding: [1.0, 0.0, 0.0] },
      { article_id: 2, embedding: [0.99, 0.1, 0.0] },
      { article_id: 3, embedding: [0.0, 0.0, 1.0] },
    ];
    const clusters = agglomerativeCluster(articles, 0.9, 25);
    // 1 & 2 should cluster, 3 stays separate
    assert.equal(clusters.length, 2);
    const bigCluster = clusters.find((c) => c.length === 2)!;
    const smallCluster = clusters.find((c) => c.length === 1)!;
    assert.ok(bigCluster);
    assert.ok(smallCluster);
    assert.equal(smallCluster[0], 2); // index 2 = article 3
  });

  it("respects max size cap", () => {
    // 10 identical articles, max size 4
    const articles = Array.from({ length: 10 }, (_, i) => ({
      article_id: i,
      embedding: [1.0, 0.0, 0.0],
    }));
    const clusters = agglomerativeCluster(articles, 0.5, 4);
    assert.ok(clusters.every((c) => c.length <= 4));
    // All articles should still be accounted for
    const total = clusters.reduce((sum, c) => sum + c.length, 0);
    assert.equal(total, 10);
  });

  it("returns singletons when threshold is very high", () => {
    const articles = [
      { article_id: 1, embedding: [1.0, 0.0] },
      { article_id: 2, embedding: [0.0, 1.0] },
    ];
    const clusters = agglomerativeCluster(articles, 0.99, 25);
    assert.equal(clusters.length, 2);
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(agglomerativeCluster([], 0.5, 25), []);
  });

  it("handles single article", () => {
    const clusters = agglomerativeCluster(
      [{ article_id: 1, embedding: [1, 0] }],
      0.5,
      25,
    );
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0], [0]);
  });
});

describe("CLUSTER_CONFIG", () => {
  it("has reasonable thresholds", () => {
    assert.ok(CLUSTER_CONFIG.SIMILARITY_THRESHOLD > 0.5);
    assert.ok(CLUSTER_CONFIG.SIMILARITY_THRESHOLD < 0.9);
    assert.ok(CLUSTER_CONFIG.MERGE_THRESHOLD > CLUSTER_CONFIG.SIMILARITY_THRESHOLD);
    assert.ok(CLUSTER_CONFIG.MAX_CLUSTER_SIZE >= 10);
    assert.ok(CLUSTER_CONFIG.MAX_CLUSTER_SIZE <= 50);
    assert.ok(CLUSTER_CONFIG.LOOKBACK_DAYS >= 3);
    assert.ok(CLUSTER_CONFIG.LOOKBACK_DAYS <= 14);
  });
});
