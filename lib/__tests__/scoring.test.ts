import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HL_CLUSTER_H,
  NOVELTY_DISTANCE_CEIL,
  NOVELTY_DISTANCE_FLOOR,
  SCORE_WEIGHTS,
  clusterFreshnessSql,
  serveTimeScoreSql,
} from "../scoring";

describe("SCORE_WEIGHTS", () => {
  it("unit blend (freshness + base components) sums to exactly 1", () => {
    const unit =
      SCORE_WEIGHTS.freshness +
      SCORE_WEIGHTS.velocity +
      SCORE_WEIGHTS.coverage +
      SCORE_WEIGHTS.avgWeight +
      SCORE_WEIGHTS.pool;
    assert.ok(
      Math.abs(unit - 1.0) < 1e-9,
      `documented shares must be real shares; got ${unit}`,
    );
  });

  it("novelty is a small additive boost outside the unit blend", () => {
    assert.ok(SCORE_WEIGHTS.novelty > 0);
    assert.ok(SCORE_WEIGHTS.novelty <= 0.05);
  });

  it("novelty ramp is a valid, non-degenerate cosine-distance range", () => {
    assert.ok(NOVELTY_DISTANCE_FLOOR > 0);
    assert.ok(NOVELTY_DISTANCE_CEIL < 1);
    assert.ok(NOVELTY_DISTANCE_CEIL > NOVELTY_DISTANCE_FLOOR);
  });
});

describe("clusterFreshnessSql", () => {
  const sql = clusterFreshnessSql("cs.latest_pub");

  it("embeds the caller's latest_pub expression", () => {
    assert.ok(sql.includes("now() - cs.latest_pub"));
  });

  it("is half-life exponential decay using the shared HL_CLUSTER_H", () => {
    assert.ok(sql.includes("EXP(LN(0.5)"));
    assert.ok(sql.includes(`${HL_CLUSTER_H} * 3600`));
  });

  it("clamps to (0.0001, 1] so future-dated articles can't inflate scores", () => {
    assert.ok(sql.includes("LEAST(1.0"));
    assert.ok(sql.includes("GREATEST(0.0001"));
  });
});

describe("serveTimeScoreSql", () => {
  const sql = serveTimeScoreSql("cs.base_score", "cs.latest_pub", "cs.score");

  it("applies the shared freshness weight to the read-time decay", () => {
    assert.ok(sql.includes(`${SCORE_WEIGHTS.freshness} *`));
    assert.ok(sql.includes("cs.base_score +"));
  });

  it("falls back to the stored score for pre-migration rows", () => {
    assert.ok(sql.includes("cs.latest_pub IS NOT NULL"));
    assert.ok(sql.includes("ELSE cs.score"));
  });
});
