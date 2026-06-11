import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSourceQuantContext } from "@/lib/rewriteShared";
import { validateHeadline, type HeadlineFailureReason } from "../rewrite";

/**
 * The existing rewrite.test.ts covers the boolean passesChecks(). This file
 * exercises the STRUCTURED validateHeadline() and asserts the specific
 * `reason` code for each rejection path — the codes that feed the
 * rewrite_attempts.validation_failures telemetry breakdown.
 */
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

function reasonFor(
  original: string,
  draft: string,
  context: ReturnType<typeof ctx>,
): HeadlineFailureReason | null {
  return validateHeadline(original, draft, context).reason;
}

describe("validateHeadline — reason codes", () => {
  it("empty draft → 'empty'", () => {
    assert.equal(
      reasonFor("Original climate headline here", "", ctx(false)),
      "empty",
    );
  });

  it("too-short draft → 'length'", () => {
    assert.equal(
      reasonFor("Original climate headline here", "Too short", ctx(false)),
      "length",
    );
  });

  it("over-220-char draft → 'length'", () => {
    const long = "EPA finalizes ".repeat(20).trim();
    assert.ok(long.length > 220);
    assert.equal(
      reasonFor("Original climate headline here", long, ctx(false)),
      "length",
    );
  });

  it("draft identical to original → 'unchanged'", () => {
    const headline =
      "EPA finalizes the national climate rule for all power plants today";
    assert.equal(reasonFor(headline, headline, ctx(false)), "unchanged");
  });

  it("too-few-words draft without content → 'too_short_no_content'", () => {
    const draft =
      "Internationalization decarbonization announcement yesterday afternoon";
    assert.ok(draft.length >= 50 && draft.split(/\s+/).length < 6);
    assert.equal(
      reasonFor("Some original climate headline", draft, ctx(false)),
      "too_short_no_content",
    );
  });

  it("number in draft but none in source → 'numeric_missing_in_source'", () => {
    const source =
      "Company builds offshore wind farm in the North Sea this season";
    const draft =
      "Company builds 5GW offshore wind farm in the North Sea region this year";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "numeric_missing_in_source",
    );
  });

  it("number in draft mismatching source numbers → 'numeric_mismatch'", () => {
    const source =
      "Company builds 10GW offshore wind farm in the North Sea this season";
    const draft =
      "Company builds 5GW offshore wind farm in the North Sea region this year";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "numeric_mismatch",
    );
  });

  it("political figure absent from source → 'hallucinated_political_figure'", () => {
    const source =
      "Administration finalizes new power plant emissions rule for coal facilities";
    const draft =
      "Trump administration finalizes new power plant emissions rule for coal plants";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "hallucinated_political_figure",
    );
  });

  it("hype language → 'clickbait'", () => {
    const source =
      "EPA proposes a new climate rule for power plants nationwide soon";
    const draft =
      "EPA unveils unprecedented climate rule for power plants across the nation";
    assert.equal(reasonFor(source, draft, ctx(false, source)), "clickbait");
  });

  it("hedging verb → 'weak_hedging'", () => {
    const source =
      "EPA proposes a new climate rule for power plants nationwide soon";
    const draft =
      "EPA might finalize a sweeping climate rule for power plants by next year";
    assert.equal(reasonFor(source, draft, ctx(false, source)), "weak_hedging");
  });

  it("meta-reporting filler → 'vague_meta_reporting'", () => {
    const source =
      "Federal agency publishes an emissions plan for the power sector soon";
    const draft =
      "New federal report outlines emissions strategy for the power sector nationwide";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "vague_meta_reporting",
    );
  });

  it("attribution-requiring source + modal draft without attribution → 'missing_attribution'", () => {
    const source =
      "Researchers say global emissions are rising across major economies";
    const draft =
      "Global carbon emissions will rise sharply across major economies this decade";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "missing_attribution",
    );
  });

  it("generic priority-word draft with content, no quantifier/attribution → 'weak_prioritization'", () => {
    const source =
      "Automakers are revising long-term strategy amid market shifts";
    const draft =
      "Automakers reshape long-term transition plans across global manufacturing operations";
    assert.equal(
      reasonFor("Automakers revise strategy", draft, ctx(true, source)),
      "weak_prioritization",
    );
  });

  it("clean, grounded, attributed headline → accepted (reason null)", () => {
    const original =
      "EPA announces new rule requiring 80% CO2 cuts from coal power plants by 2032";
    const draft =
      "EPA finalizes power plant rule requiring coal facilities to cut CO2 80% by 2032, agency says";
    const result = validateHeadline(
      original,
      draft,
      ctx(false, original, draft),
    );
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
  });
});

/* ================================================================== */
/*  Documented false positive (see eval report)                        */
/* ================================================================== */

describe("validateHeadline — numeric guard (unit/magnitude aware)", () => {
  // /\brip/i was tightened to /\brips?\b/i, so a grounded headline that merely
  // contains "ripe" is no longer wrongly rejected as clickbait.
  it("accepts a clean headline containing the word 'ripe' (rip false-positive fixed)", () => {
    const source =
      "Heatwave damages citrus crops across the valley as growers report losses";
    const draft =
      "Heatwave leaves ripe citrus crops rotting across the valley, growers report";
    assert.equal(validateHeadline(source, draft, ctx(false, source)).ok, true);
  });

  // The numeric guard is now unit/magnitude aware, so a 1000x scale swap is
  // caught instead of silently passing.
  it("rejects a 1000x magnitude swap (million → billion)", () => {
    const source =
      "Startup raised $5 million in a funding round to expand battery recycling operations";
    const draft =
      "Battery recycling startup raised $5 billion in funding round to expand operations nationwide";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "numeric_mismatch",
    );
  });

  it("rejects a unit swap (GW → million tons)", () => {
    const source =
      "The project will deliver 593 GW of clean capacity by 2030, the company said";
    const draft =
      "Company project will deliver 593 million tons of clean capacity by 2030, the company said";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "numeric_mismatch",
    );
  });

  // Rounding tolerance: faithful summarization rounding is no longer rejected.
  it("accepts faithful rounding of a percentage (28.7% → 29%)", () => {
    const source =
      "Renewables supplied 28.7% of national electricity last year, the regulator reported";
    const draft =
      "Renewables supplied 29% of national electricity last year, the regulator reported";
    assert.equal(validateHeadline(source, draft, ctx(false, source)).ok, true);
  });

  it("accepts a currency figure rounded to fewer significant digits ($1.17B → $1.2B)", () => {
    const source =
      "The utility booked $1.17 billion in storm recovery costs, according to its filing";
    const draft =
      "Utility books $1.2 billion in storm recovery costs in a regulatory filing, company says";
    assert.equal(validateHeadline(source, draft, ctx(false, source)).ok, true);
  });
});

describe("validateHeadline — numeric guard regression fixes (from code review)", () => {
  // Bare years must match exactly — rounding tolerance must not let a swapped
  // target year through.
  it("rejects a swapped target year (2050 → 2030)", () => {
    const source =
      "The EU agreed to reach net-zero emissions across the bloc by 2050";
    const draft =
      "EU agrees to reach net-zero emissions across the entire bloc by 2030";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "numeric_mismatch",
    );
  });

  it("rejects a swapped small count (40 → 41 plants)", () => {
    const source =
      "The agency ordered 40 aging coal plants to install scrubbers by the deadline";
    const draft =
      "Agency orders 41 aging coal plants to install pollution scrubbers by the deadline";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "numeric_mismatch",
    );
  });

  // Faithful rewrites that spell the unit differently, or add a currency symbol,
  // must NOT be rejected as numeric_mismatch.
  it("accepts a spelled-out unit matching the abbreviation (GW ↔ gigawatts)", () => {
    const source =
      "The developer will deliver 2.6 GW of offshore wind capacity by 2031";
    const draft =
      "Developer to deliver 2.6 gigawatts of offshore wind capacity by 2031, it says";
    assert.equal(validateHeadline(source, draft, ctx(false, source)).ok, true);
  });

  it("accepts a currency symbol added to a spelled amount (5 billion ↔ $5 billion)", () => {
    const source =
      "The fund raised 5 billion to finance grid-scale battery storage projects";
    const draft =
      "Fund raises $5 billion to finance grid-scale battery storage projects nationwide";
    assert.equal(validateHeadline(source, draft, ctx(false, source)).ok, true);
  });
});

describe("validateHeadline — entity hallucination guard", () => {
  // Source intentionally does NOT contain the draft text, so the guard runs
  // against realistic source material (title+dek+content), not the draft.
  it("rejects a world leader absent from the source (expanded name list)", () => {
    const source =
      "India unveils a new solar manufacturing incentive to cut coal reliance and emissions";
    const draft =
      "Modi unveils India solar manufacturing incentive to cut coal reliance and emissions";
    assert.equal(
      reasonFor(source, draft, ctx(false, source)),
      "hallucinated_political_figure",
    );
  });

  it("accepts a world leader that DOES appear in the source", () => {
    const source =
      "Macron pledged France would accelerate its nuclear-power buildout to cut emissions";
    const draft =
      "Macron pledges France will accelerate nuclear-power buildout to cut emissions, he says";
    assert.equal(validateHeadline(source, draft, ctx(false, source)).ok, true);
  });

  // Multi-word entity guard (only active when hasContent=true).
  it("rejects a multi-word org name wholly absent from source content → 'hallucinated_entity'", () => {
    const source =
      "A battery developer secured 200 million in funding to expand solid-state cell output at two plants this year";
    const draft =
      "Northvolt Systems secures 200 million to expand solid-state battery cell output at two new plants this year";
    assert.equal(
      reasonFor("Battery maker raises funds", draft, ctx(true, source)),
      "hallucinated_entity",
    );
  });

  it("accepts a multi-word entity that shares a token with the source", () => {
    const source =
      "The Mountain Valley Pipeline was blocked by a federal appeals court over environmental review failures and water permits";
    const draft =
      "Federal appeals court blocks Mountain Valley Pipeline over environmental review failures, water permit issues nationwide";
    assert.equal(validateHeadline("x", draft, ctx(true, source)).ok, true);
  });

  it("does not run the entity guard without content (title+dek only)", () => {
    const source = "Court blocks pipeline over permits";
    const draft =
      "Federal Energy Regulatory Commission blocks Atlantic Coast Pipeline over water permit issues, citing review gaps";
    // hasContent=false → entity guard skipped; should not be hallucinated_entity
    assert.notEqual(
      reasonFor("Court blocks pipeline", draft, ctx(false, source)),
      "hallucinated_entity",
    );
  });
});

describe("validateHeadline — meta-refusal + prioritization exception", () => {
  it("rejects a refusal sentence emitted as the headline → 'meta_refusal'", () => {
    const draft =
      "No climate or energy entity action found in source; headline not applicable for rewriting";
    assert.equal(
      reasonFor("Some climate story headline", draft, ctx(false)),
      "meta_refusal",
    );
  });

  it("accepts a 'legal challenge' headline (prioritization exception)", () => {
    const source =
      "A coalition of states filed a legal challenge to the EPA power plant rule in federal court, arguing the agency exceeded its authority over emissions limits under the law";
    const draft =
      "States file legal challenge to EPA power plant rule, arguing agency exceeded its authority over emissions limits";
    assert.equal(validateHeadline("x", draft, ctx(true, source)).ok, true);
  });
});
