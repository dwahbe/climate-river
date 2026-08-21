import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGE_DAMPING_FLOOR,
  AGE_DAMPING_HL_H,
  HL_CLUSTER_H,
  NOVELTY_DISTANCE_CEIL,
  NOVELTY_DISTANCE_FLOOR,
  SCORE_WEIGHTS,
  SINGLETON_DISCOUNT,
  TOP_GATE,
  clusterAgeDampingSql,
  clusterFreshnessSql,
  publisherHostSql,
  serveTimeScoreSql,
  singletonDiscountSql,
  sourceWeightSql,
  strongSourceCountSql,
  topGateSql,
} from "../scoring";

describe("SCORE_WEIGHTS", () => {
  it("unit blend (freshness + base components) sums to exactly 1", () => {
    const unit =
      SCORE_WEIGHTS.freshness +
      SCORE_WEIGHTS.velocity +
      SCORE_WEIGHTS.coverage +
      SCORE_WEIGHTS.authority +
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

describe("clusterAgeDampingSql", () => {
  const sql = clusterAgeDampingSql("cs.first_pub");
  it("is a floored half-life on the cluster's first publication", () => {
    assert.ok(sql.includes("now() - cs.first_pub"));
    assert.ok(sql.includes(`${AGE_DAMPING_HL_H} * 3600`));
    assert.ok(sql.includes(`GREATEST(${AGE_DAMPING_FLOOR}`));
    assert.ok(sql.includes("LEAST(1.0"));
  });
  it("does not damp pre-migration rows with no first_pub", () => {
    assert.ok(sql.includes("WHEN cs.first_pub IS NULL THEN 1.0"));
  });
  it("floor keeps old stories visible rather than hidden", () => {
    assert.ok(AGE_DAMPING_FLOOR >= 0.25 && AGE_DAMPING_FLOOR < 1);
    assert.ok(AGE_DAMPING_HL_H >= 24);
  });
});

describe("topGateSql", () => {
  const sql = topGateSql("cc.strong_sources", "cc.lead_weight");
  it("passes on corroboration OR a top-tier lead", () => {
    assert.ok(sql.includes(`>= ${TOP_GATE.minStrongSources}`));
    assert.ok(sql.includes(`>= ${TOP_GATE.minLeadWeight}`));
    assert.ok(sql.includes(" OR "));
  });
  it("treats unknown strong-source counts as eligible (no surprise hiding)", () => {
    assert.ok(
      sql.includes(`COALESCE(cc.strong_sources, ${TOP_GATE.minStrongSources})`),
    );
  });
  it("gate constants are sane", () => {
    assert.ok(TOP_GATE.minStrongSources >= 2);
    assert.ok(TOP_GATE.minLeadWeight >= 6 && TOP_GATE.minLeadWeight <= 10);
    assert.ok(TOP_GATE.strongSourceMinWeight > 2);
  });
});

describe("singletonDiscountSql", () => {
  const sql = singletonDiscountSql("cb.strong_sources");
  it("discounts uncorroborated clusters and leaves others at 1.0", () => {
    assert.ok(sql.includes(`THEN ${SINGLETON_DISCOUNT}`));
    assert.ok(sql.includes("ELSE 1.0"));
    assert.ok(sql.includes(`< ${TOP_GATE.minStrongSources}`));
  });
  it("treats unknown counts as corroborated (no surprise demotion)", () => {
    assert.ok(
      sql.includes(`COALESCE(cb.strong_sources, ${TOP_GATE.minStrongSources})`),
    );
  });
  it("is a mild ordering nudge, not a hide", () => {
    assert.ok(SINGLETON_DISCOUNT >= 0.7 && SINGLETON_DISCOUNT < 1);
  });
});

describe("outlet-based corroboration helpers", () => {
  it("publisherHostSql normalizes scheme, port and common prefixes", () => {
    const sql = publisherHostSql("a.canonical_url");
    assert.ok(
      sql.includes(
        "split_part(split_part(split_part(a.canonical_url, '://', 2), '/', 1), ':', 1)",
      ),
    );
    assert.ok(sql.includes("^(www|m|mobile|amp|amp-cdn|edition|news|beta)"));
  });
  it("strongSourceCountSql counts distinct hosts above the strong-weight floor", () => {
    const sql = strongSourceCountSql("a.host_norm", "a.src_weight");
    assert.ok(sql.startsWith("COUNT(DISTINCT a.host_norm) FILTER"));
    assert.ok(sql.includes(`>= ${TOP_GATE.strongSourceMinWeight}`));
  });
  it("sourceWeightSql caps journal-paper URLs and falls back to the unknown weight", () => {
    const sql = sourceWeightSql("s.weight", "a.canonical_url");
    assert.ok(sql.includes("a.canonical_url ~*"));
    assert.ok(sql.includes("LEAST(COALESCE(s.weight"));
    assert.ok(sql.includes("ELSE COALESCE(s.weight"));
  });
});
