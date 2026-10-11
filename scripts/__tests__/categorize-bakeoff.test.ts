import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  armsDisagree,
  buildFinalSummaryMarkdown,
  buildReviewRows,
  parseGoldLabels,
  scoreArm,
  type GoldLabel,
  type SampleRecord,
} from "../categorize-bakeoff";
import {
  buildEvaluationQuestions,
  buildLanguageArmInstructions,
  combineRelevanceSignals,
  decide,
  type ArmPrediction,
} from "../categorize-eval";

const THRESHOLDS = { climate: 0.5, category: 0.5 };

function prediction(overrides: Partial<ArmPrediction>): ArmPrediction {
  return {
    articleId: 1,
    armId: "jev",
    kind: "evaluation",
    model: "typesafe-ai/jev",
    ok: true,
    error: null,
    climateProbability: 0.9,
    categoryProbabilities: { government: 0.8, business: 0.6, tech: 0.2 },
    rankedCategories: null,
    primaryChoice: null,
    englishProbability: null,
    articleType: "news_report",
    articleTypeProbabilities: null,
    relevanceSignals: null,
    impactKind: null,
    latencyMs: 300,
    inputTokens: 600,
    outputTokens: 0,
    estimatedCostUsd: 0.000025,
    ...overrides,
  };
}

function sample(articleId: number): SampleRecord {
  return {
    articleId,
    sourceName: "Grist",
    canonicalUrl: `https://example.com/${articleId}`,
    publishedAt: "2026-09-20T12:00:00Z",
    title: `Story ${articleId}`,
    summary: "Summary",
    trusted: false,
    storedPrimary: null,
    categorizeStatus: null,
  };
}

function label(overrides: Partial<GoldLabel>): GoldLabel {
  return {
    articleId: 1,
    climate: true,
    primaryLabelled: true,
    primary: "government",
    categories: ["government"],
    articleType: null,
    storyKind: null,
    ...overrides,
  };
}

describe("decide", () => {
  it("assigns categories above the threshold, highest first", () => {
    const decision = decide(prediction({}), THRESHOLDS);
    assert.deepEqual(decision?.categories, ["government", "business"]);
    assert.equal(decision?.primary, "government");
  });

  it("assigns no categories when the article is not climate", () => {
    const decision = decide(
      prediction({ climateProbability: 0.2 }),
      THRESHOLDS,
    );
    assert.equal(decision?.climate, false);
    assert.deepEqual(decision?.categories, []);
    assert.equal(decision?.primary, null);
  });

  it("keeps the production arm's own ranking regardless of thresholds", () => {
    const decision = decide(
      prediction({
        kind: "production",
        climateProbability: 1,
        categoryProbabilities: { impacts: 0.4, research: 0.3 },
        rankedCategories: ["impacts", "research"],
      }),
      { climate: 0.5, category: 0.9 },
    );
    assert.deepEqual(decision?.categories, ["impacts", "research"]);
  });

  it("returns null for a failed call", () => {
    assert.equal(
      decide(prediction({ ok: false, climateProbability: null }), THRESHOLDS),
      null,
    );
  });
});

describe("armsDisagree", () => {
  it("flags a different primary category", () => {
    assert.equal(
      armsDisagree(
        [
          prediction({ armId: "a" }),
          prediction({
            armId: "b",
            categoryProbabilities: { business: 0.9 },
          }),
        ],
        THRESHOLDS,
      ),
      true,
    );
  });

  it("ignores failed arms", () => {
    assert.equal(
      armsDisagree(
        [
          prediction({ armId: "a" }),
          prediction({ armId: "b" }),
          prediction({ armId: "c", ok: false, climateProbability: null }),
        ],
        THRESHOLDS,
      ),
      false,
    );
  });
});

describe("buildReviewRows", () => {
  it("puts disagreement rows first and exposes no predictions", () => {
    const rows = buildReviewRows(
      [sample(1), sample(2)],
      [
        prediction({ articleId: 1, armId: "a" }),
        prediction({ articleId: 1, armId: "b" }),
        prediction({ articleId: 2, armId: "a" }),
        prediction({ articleId: 2, armId: "b", climateProbability: 0.1 }),
      ],
      THRESHOLDS,
    );

    assert.deepEqual(
      rows.map((row) => [row.article_id, row.arms_disagree]),
      [
        [2, "yes"],
        [1, "no"],
      ],
    );
    assert.deepEqual(Object.keys(rows[0]), [
      "article_id",
      "arms_disagree",
      "source_name",
      "published_at",
      "canonical_url",
      "title",
      "summary",
      "label_climate",
      "label_primary",
      "label_secondary",
      "label_article_type",
      "label_story_kind",
      "notes",
    ]);
    assert.equal(rows[0].label_climate, "");
  });
});

describe("parseGoldLabels", () => {
  it("accepts slugs and display names, and skips unlabelled rows", () => {
    const { labels, warnings } = parseGoldLabels([
      {
        article_id: "1",
        label_climate: "Y",
        label_primary: "Activism",
        label_secondary: "government, tech",
        label_article_type: "opinion",
      },
      { article_id: "2", label_climate: "n", label_primary: "" },
      { article_id: "3", label_climate: "", label_primary: "tech" },
    ]);

    assert.deepEqual(warnings, []);
    assert.equal(labels.length, 2);
    assert.deepEqual(labels[0], {
      articleId: 1,
      climate: true,
      primaryLabelled: true,
      primary: "justice",
      categories: ["justice", "government", "tech"],
      articleType: "opinion",
      storyKind: null,
    });
    assert.equal(labels[1].climate, false);
    assert.equal(labels[1].primary, null);
  });

  it("treats none as a labelled primary and blank as unlabelled", () => {
    const { labels } = parseGoldLabels([
      { article_id: "1", label_climate: "y", label_primary: "none" },
      { article_id: "2", label_climate: "y", label_primary: "" },
    ]);
    assert.equal(labels[0].primaryLabelled, true);
    assert.equal(labels[0].primary, null);
    assert.equal(labels[1].primaryLabelled, false);
  });

  it("warns on values it cannot read", () => {
    const { labels, warnings } = parseGoldLabels([
      { article_id: "1", label_climate: "maybe" },
      { article_id: "2", label_climate: "y", label_primary: "weather" },
    ]);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].primaryLabelled, false);
    assert.equal(warnings.length, 2);
  });
});

describe("scoreArm", () => {
  it("scores relevance, primary and assigned categories", () => {
    const score = scoreArm(
      "jev",
      [
        prediction({ articleId: 1 }),
        prediction({ articleId: 2, climateProbability: 0.8 }),
        prediction({ articleId: 3, climateProbability: 0.1 }),
        prediction({
          articleId: 4,
          categoryProbabilities: { business: 0.9 },
        }),
      ],
      [
        label({ articleId: 1 }),
        label({
          articleId: 2,
          climate: false,
          primary: null,
          categories: [],
        }),
        label({ articleId: 3 }),
        label({
          articleId: 4,
          primary: "tech",
          categories: ["tech", "business"],
        }),
      ],
      THRESHOLDS,
    );

    assert.deepEqual(
      [
        score.relevance.tp,
        score.relevance.fp,
        score.relevance.tn,
        score.relevance.fn,
      ],
      [2, 1, 0, 1],
    );
    assert.equal(score.relevance.accuracy, 0.5);
    assert.equal(score.primary.total, 3);
    assert.equal(score.primary.exact, 1);
    assert.equal(score.primary.lenient, 2);
    assert.deepEqual(
      [score.multiLabel.tp, score.multiLabel.fp, score.multiLabel.fn],
      [2, 1, 2],
    );
  });

  it("counts a failed call as wrong", () => {
    const score = scoreArm(
      "jev",
      [prediction({ ok: false, climateProbability: null })],
      [label({})],
      THRESHOLDS,
    );
    assert.equal(score.failed, 1);
    assert.equal(score.relevance.accuracy, 0);
    assert.equal(score.primary.exactAccuracy, 0);
    assert.equal(score.multiLabel.fn, 1);
  });

  it("reports no article type score for arms that never produce one", () => {
    const score = scoreArm(
      "production-hybrid",
      [
        prediction({
          armId: "production-hybrid",
          kind: "production",
          articleType: null,
        }),
      ],
      [label({ articleType: "opinion" })],
      THRESHOLDS,
    );
    assert.equal(score.articleType, null);
  });
});

describe("buildFinalSummaryMarkdown", () => {
  it("asks for labels when none are filled in", () => {
    const report = buildFinalSummaryMarkdown(
      [prediction({})],
      [{ article_id: "1", label_climate: "" }],
      THRESHOLDS,
    );
    assert.match(report, /No labels found/);
  });

  it("sweeps thresholds only for arms that have them", () => {
    const report = buildFinalSummaryMarkdown(
      [
        prediction({}),
        prediction({
          armId: "production-hybrid",
          kind: "production",
          climateProbability: 1,
          rankedCategories: ["government"],
        }),
      ],
      [
        {
          article_id: "1",
          arms_disagree: "no",
          label_climate: "y",
          label_primary: "government",
        },
      ],
      THRESHOLDS,
    );
    assert.match(report, /\| jev \| Relevance F1 by climate threshold/);
    assert.doesNotMatch(report, /\| production-hybrid \| Relevance F1/);
  });

  it("matches labels to predictions stored with string ids", () => {
    const report = buildFinalSummaryMarkdown(
      [prediction({ articleId: "1" as unknown as number })],
      [
        {
          article_id: "1",
          arms_disagree: "no",
          label_climate: "y",
          label_primary: "government",
        },
      ],
      THRESHOLDS,
    );
    assert.match(report, /\| jev \| 100\.0% \| 100\.0% \| 100\.0% \| 100\.0% /);
  });
});

describe("instruction sets", () => {
  it("rubric questions carry the weather bar and category scope", () => {
    const questions = buildEvaluationQuestions("rubric");
    assert.match(String(questions.climate.instructions), /forecasts, watches/);
    assert.match(String(questions.climate.instructions), /side stories/);
    assert.match(
      String(questions.category_justice.instructions),
      /lawsuits brought by activists/,
    );
  });

  it("baseline questions fall back to the category description", () => {
    const questions = buildEvaluationQuestions("baseline");
    assert.doesNotMatch(
      String(questions.climate.instructions),
      /forecasts, watches/,
    );
    assert.match(
      String(questions.category_justice.instructions),
      /Climate protests, rallies, strikes/,
    );
  });

  it("offers every article type, including not_news", () => {
    const questions = buildEvaluationQuestions("rubric");
    const articleType = questions.article_type;
    assert.equal(articleType.type, "choice");
    assert.ok("not_news" in (articleType.criteria as Record<string, unknown>));
    assert.match(buildLanguageArmInstructions("rubric"), /not_news/);
  });
});

const QUIET = {
  scope_science: 0,
  scope_energy: 0,
  scope_policy: 0,
  scope_finance: 0,
  scope_adaptation: 0,
  impact_signal: 0,
  impact_linked: 0,
  weather_event: 0,
  weather_forecast: 0,
  weather_scale: 0,
  side_story: 0,
};

describe("combineRelevanceSignals", () => {
  it("lets a core topic in with no impact kind", () => {
    const result = combineRelevanceSignals({ ...QUIET, scope_energy: 0.9 });
    assert.equal(result.climate, 0.9);
    assert.equal(result.impactKind, null);
  });

  it("lets a weather event in only when it has scale", () => {
    const flood = { ...QUIET, weather_event: 0.95 };
    assert.equal(combineRelevanceSignals(flood).climate, 0);
    const deadly = combineRelevanceSignals({ ...flood, weather_scale: 0.9 });
    assert.equal(deadly.climate, 0.9);
    assert.equal(deadly.impactKind, "event");
  });

  it("keeps forecasts and side stories out", () => {
    const big = { ...QUIET, weather_event: 0.9, weather_scale: 0.9 };
    assert.ok(
      combineRelevanceSignals({ ...big, weather_forecast: 0.8 }).climate < 0.5,
    );
    assert.ok(
      combineRelevanceSignals({ ...big, side_story: 0.9 }).climate < 0.5,
    );
  });

  it("lets a stated climate link in without any scale", () => {
    const result = combineRelevanceSignals({
      ...QUIET,
      weather_event: 0.9,
      impact_linked: 0.85,
    });
    assert.equal(result.climate, 0.85);
    assert.equal(result.impactKind, "linked");
  });

  it("treats a forecast as a veto on preparedness advice", () => {
    const result = combineRelevanceSignals({
      ...QUIET,
      scope_adaptation: 0.9,
      weather_forecast: 0.9,
    });
    assert.ok(result.climate < 0.5);
  });
});

describe("composite instructions", () => {
  it("asks each signal as its own question and no single climate question", () => {
    const questions = buildEvaluationQuestions("composite");
    assert.equal(questions.climate, undefined);
    assert.equal(questions.signal_weather_forecast.type, "boolean");
    assert.match(
      buildLanguageArmInstructions("composite"),
      /weather_scale: Does the text report/,
    );
  });
});

describe("story kinds", () => {
  it("parses the kind and reports relevance by kind", () => {
    const rows: Array<Record<string, string>> = [
      {
        article_id: "1",
        label_climate: "y",
        label_primary: "impacts",
        label_story_kind: "event",
      },
      { article_id: "2", label_climate: "n", label_story_kind: "routine" },
    ];
    const { labels, warnings } = parseGoldLabels(rows);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      labels.map((l) => l.storyKind),
      ["event", "routine"],
    );

    const report = buildFinalSummaryMarkdown(
      [
        prediction({ articleId: 1 }),
        prediction({ articleId: 2, climateProbability: 0.9 }),
      ],
      rows,
      THRESHOLDS,
    );
    assert.match(report, /## Relevance by kind of story/);
    assert.match(report, /\| jev \| 100\.0% \| 0\.0% \|/);
  });
});
