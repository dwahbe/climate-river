import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARTICLE_TYPE_KEYS,
  CATEGORY_SLUGS,
  buildJudgmentInput,
  buildJudgmentQuestions,
  isChoiceTieError,
  judgeArticle,
  parseJudgmentAnswers,
  primaryFromCategories,
  type EvaluateFn,
} from "../articleJudgment";

type Answers = Awaited<ReturnType<EvaluateFn>>["answers"];

function answers(overrides: Answers = {}): Answers {
  return {
    climate: { type: "boolean", probability: 0.9 },
    english: { type: "boolean", probability: 0.99 },
    category_government: { type: "boolean", probability: 0.8 },
    category_justice: { type: "boolean", probability: 0.1 },
    category_business: { type: "boolean", probability: 0.6 },
    category_impacts: { type: "boolean", probability: 0.2 },
    category_tech: { type: "boolean", probability: 0.1 },
    category_research: { type: "boolean", probability: 0.1 },
    primary: {
      type: "choice",
      choice: "business",
      probabilities: { business: 0.6, government: 0.4 },
    },
    article_type: { type: "choice", choice: "news_report" },
    ...overrides,
  };
}

function without(source: Answers, ...keys: string[]): Answers {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}

describe("buildJudgmentInput", () => {
  it("joins dek and content and caps the length", () => {
    const input = buildJudgmentInput("Title", "Dek.", "x".repeat(5000));
    assert.equal(input.title, "Title");
    assert.ok(input.summary?.startsWith("Dek. x"));
    assert.equal(input.summary?.length, 2000);
  });

  it("returns a null summary when there is no text", () => {
    assert.equal(buildJudgmentInput("Title", null, null).summary, null);
  });
});

describe("buildJudgmentQuestions", () => {
  it("asks relevance, language, every category, and both pick-one questions", () => {
    const questions = buildJudgmentQuestions();
    assert.deepEqual(
      Object.keys(questions).sort(),
      [
        "article_type",
        ...CATEGORY_SLUGS.map((slug) => `category_${slug}`),
        "climate",
        "english",
        "primary",
      ].sort(),
    );
    const primary = questions.primary;
    assert.equal(primary.type, "choice");
    assert.deepEqual(
      Object.keys(primary.criteria as Record<string, unknown>).sort(),
      [...CATEGORY_SLUGS, "none"].sort(),
    );
    const type = questions.article_type;
    assert.deepEqual(
      Object.keys(type.criteria as Record<string, unknown>),
      ARTICLE_TYPE_KEYS,
    );
  });

  it("drops the pick-one questions on request", () => {
    const questions = buildJudgmentQuestions({ choices: false });
    assert.equal(questions.primary, undefined);
    assert.equal(questions.article_type, undefined);
    assert.equal(questions.climate.type, "boolean");
  });
});

describe("parseJudgmentAnswers", () => {
  it("takes the primary from the pick-one question, not the highest yes/no", () => {
    const judgment = parseJudgmentAnswers(answers());
    assert.equal(judgment.primary, "business");
    assert.equal(judgment.categoryP.government, 0.8);
    assert.equal(judgment.articleType, "news_report");
    assert.equal(judgment.climateP, 0.9);
  });

  it("falls back to the yes/no answers when there is no pick-one answer", () => {
    const rest = without(answers(), "primary", "article_type");
    const judgment = parseJudgmentAnswers(rest);
    assert.equal(judgment.primary, "government");
    assert.equal(judgment.primaryP, null);
    assert.equal(judgment.articleType, null);
  });

  it("ignores a choice that is not a known category or type", () => {
    const judgment = parseJudgmentAnswers(
      answers({
        primary: { type: "choice", choice: "weather" },
        article_type: { type: "choice", choice: "blog" },
      }),
    );
    assert.equal(judgment.primary, "government");
    assert.equal(judgment.articleType, null);
  });

  it("clamps probabilities and rejects a missing answer", () => {
    assert.equal(
      parseJudgmentAnswers(
        answers({ climate: { type: "boolean", probability: 1.2 } }),
      ).climateP,
      1,
    );
    const rest = without(answers(), "english");
    assert.throws(() => parseJudgmentAnswers(rest), /missing_answer:english/);
  });
});

describe("primaryFromCategories", () => {
  it("returns none when no category clears the threshold", () => {
    assert.equal(
      primaryFromCategories({
        government: 0.4,
        justice: 0.1,
        business: 0.3,
        impacts: 0.2,
        tech: 0.1,
        research: 0.1,
      }),
      "none",
    );
  });
});

describe("judgeArticle", () => {
  const input = { title: "EPA repeals emission limits", summary: null };

  it("returns the parsed judgment and token count", async () => {
    const result = await judgeArticle(input, {
      evaluateFn: async () => ({ answers: answers(), inputTokens: 900 }),
    });
    assert.equal(result.judgment.primary, "business");
    assert.equal(result.inputTokens, 900);
    assert.equal(result.usedFallback, false);
  });

  it("retries without the pick-one questions when one ties", async () => {
    const asked: string[][] = [];
    const result = await judgeArticle(input, {
      evaluateFn: async ({ questions }) => {
        asked.push(Object.keys(questions));
        if ("primary" in questions) {
          throw new Error(
            'Question "article_type" did not select a highest-probability option.',
          );
        }
        const rest = without(answers(), "primary", "article_type");
        return { answers: rest, inputTokens: 700 };
      },
    });
    assert.equal(asked.length, 2);
    assert.ok(!asked[1].includes("primary"));
    assert.equal(result.usedFallback, true);
    assert.equal(result.judgment.primary, "government");
  });

  it("does not retry other failures", async () => {
    let calls = 0;
    await assert.rejects(
      judgeArticle(input, {
        evaluateFn: async () => {
          calls += 1;
          throw new Error("Rate limit exceeded");
        },
      }),
      /Rate limit/,
    );
    assert.equal(calls, 1);
  });
});

describe("isChoiceTieError", () => {
  it("matches only the tie message", () => {
    assert.equal(
      isChoiceTieError(
        new Error(
          'Question "primary" did not select a highest-probability option.',
        ),
      ),
      true,
    );
    assert.equal(isChoiceTieError(new Error("timeout")), false);
    assert.equal(isChoiceTieError("did not select"), false);
  });
});
