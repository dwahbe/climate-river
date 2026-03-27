import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSourceQuantContext } from "../rewrite";
import {
  buildSystemPrompt,
  buildUserPrompt,
  getEvalProfiles,
  validateDraft,
} from "../rewrite-eval";

function ctx(
  hasContent: boolean,
  ...sourceParts: Array<string | null | undefined>
) {
  const filtered = sourceParts.filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return {
    hasContent,
    sourceQuant: buildSourceQuantContext(
      sourceParts.length > 0 ? sourceParts : [null],
    ),
    sourceText: filtered.join(" "),
  };
}

describe("eval profiles", () => {
  it("returns at least one profile", () => {
    const profiles = getEvalProfiles();
    assert.ok(profiles.length > 0);
  });

  it("every profile has required fields", () => {
    for (const p of getEvalProfiles()) {
      assert.ok(p.id, "profile must have an id");
      assert.ok(p.provider, "profile must have a provider");
      assert.ok(p.modelId, "profile must have a modelId");
      assert.ok(
        p.promptVariant === "legacy" || p.promptVariant === "structured",
        "promptVariant must be legacy or structured",
      );
      assert.ok(typeof p.temperature === "number");
      assert.ok(typeof p.maxOutputTokens === "number");
    }
  });

  it("profile IDs are unique", () => {
    const ids = getEvalProfiles().map((p) => p.id);
    assert.deepEqual(ids, [...new Set(ids)]);
  });
});

describe("rewrite-eval prompt contract", () => {
  it("frames the structured task as a dense single-line summary", () => {
    const prompt = buildSystemPrompt("structured");
    assert.match(prompt, /single-line summary/i);
    assert.match(prompt, /study finds/i);
    assert.match(prompt, /Andy Jassy says/i);
    assert.match(prompt, /Never ask follow-up questions/i);
  });

  it("uses summary wording in the structured user prompt", () => {
    const prompt = buildUserPrompt(
      {
        title: "EPA finalizes power plant emissions rule",
        dek: "Coal plants must cut carbon sharply by 2032",
      },
      "structured",
    );
    assert.match(prompt, /dense single-line summary/i);
  });

  it("keeps headline wording in the legacy user prompt", () => {
    const prompt = buildUserPrompt(
      {
        title: "EPA finalizes power plant emissions rule",
      },
      "legacy",
    );
    assert.match(prompt, /Rewrite this headline/i);
  });
});

describe("rewrite-eval validation", () => {
  it("flags missing attribution for executive statements", () => {
    const source =
      "CEO Andy Jassy says Amazon will produce 100 million units next year under the new climate product plan";
    const draft =
      "Amazon will produce 100M units next year under new climate product plan";
    const result = validateDraft("Amazon climate product plan", draft, ctx(false, source));
    assert.equal(result.ok, false);
    assert.equal(result.code, "missing_attribution");
  });

  it("flags vague topic summaries explicitly", () => {
    const draft =
      "New climate report explores energy transition trends across global markets";
    const result = validateDraft(
      "Climate report",
      draft,
      ctx(false, "A new report says global clean energy investment rose sharply"),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "vague_topic_summary");
  });
});
