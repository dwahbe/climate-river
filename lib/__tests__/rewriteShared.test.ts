import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractNumericTokens,
  normalizeNumericToken,
  containsQuantifier,
  hasAttribution,
  buildSourceQuantContext,
  parseMeasurements,
  measurementsMatch,
  numbersClose,
  CLICKBAIT_PATTERNS,
  WEAK_PATTERNS,
  VAGUE_PATTERNS,
} from "../rewriteShared";

const clickbait = (s: string) => CLICKBAIT_PATTERNS.some((p) => p.test(s));
const weak = (s: string) => WEAK_PATTERNS.some((p) => p.test(s));
const vague = (s: string) => VAGUE_PATTERNS.some((p) => p.test(s));

/* ================================================================== */
/*  extractNumericTokens / normalizeNumericToken                       */
/* ================================================================== */

describe("extractNumericTokens", () => {
  it("normalizes percent words and symbols to the same token", () => {
    assert.deepEqual(extractNumericTokens("up 30%"), ["30%"]);
    assert.deepEqual(extractNumericTokens("up 30 percent"), ["30%"]);
  });

  it("treats '2.6GW' and '2.6 GW' identically (unit stripped)", () => {
    assert.deepEqual(extractNumericTokens("a 2.6GW project"), ["2.6"]);
    assert.deepEqual(extractNumericTokens("a 2.6 GW project"), ["2.6"]);
  });

  it("strips thousands separators", () => {
    assert.deepEqual(extractNumericTokens("1,200 megawatts"), ["1200"]);
  });

  it("extracts years as plain numbers", () => {
    assert.deepEqual(extractNumericTokens("593GW in 2024"), ["593", "2024"]);
  });

  it("returns [] for null/undefined/empty and number-free text", () => {
    assert.deepEqual(extractNumericTokens(null), []);
    assert.deepEqual(extractNumericTokens(undefined), []);
    assert.deepEqual(extractNumericTokens(""), []);
    assert.deepEqual(extractNumericTokens("no digits here"), []);
  });

  // The low-level digit tokenizer intentionally returns bare digits; magnitude
  // and unit awareness now lives in parseMeasurements (tested below), which is
  // what the hallucination guard uses.
  it("returns bare digits (magnitude handled separately by parseMeasurements)", () => {
    assert.deepEqual(extractNumericTokens("$5 million"), ["5"]);
    assert.deepEqual(extractNumericTokens("$5 billion"), ["5"]);
  });
});

/* ================================================================== */
/*  parseMeasurements / measurementsMatch / numbersClose               */
/* ================================================================== */

describe("parseMeasurements", () => {
  it("scales magnitude words against a currency", () => {
    assert.deepEqual(parseMeasurements("$5 million"), [
      { value: 5e6, unit: "$" },
    ]);
    assert.deepEqual(parseMeasurements("$5 billion"), [
      { value: 5e9, unit: "$" },
    ]);
  });

  it("scales the currency abbreviation form ($1.2B)", () => {
    assert.deepEqual(parseMeasurements("$1.2B"), [{ value: 1.2e9, unit: "$" }]);
  });

  it("normalizes units regardless of spacing", () => {
    assert.deepEqual(parseMeasurements("2.6GW"), [{ value: 2.6, unit: "gw" }]);
    assert.deepEqual(parseMeasurements("2.6 GW"), [{ value: 2.6, unit: "gw" }]);
  });

  it("normalizes spelled-out units to the abbreviated canonical token", () => {
    assert.deepEqual(parseMeasurements("2.6 gigawatts"), [
      { value: 2.6, unit: "gw" },
    ]);
    assert.deepEqual(parseMeasurements("500 megawatts"), [
      { value: 500, unit: "mw" },
    ]);
    assert.deepEqual(parseMeasurements("10 gigatonnes"), [
      { value: 10, unit: "gt" },
    ]);
  });

  it("treats percent symbol and word identically", () => {
    assert.deepEqual(parseMeasurements("30%"), [{ value: 30, unit: "%" }]);
    assert.deepEqual(parseMeasurements("30 percent"), [
      { value: 30, unit: "%" },
    ]);
  });

  it("applies magnitude word even when the trailing unit is dropped", () => {
    // "593 million tons" → 593,000,000 (the magnitude is what matters for swaps)
    assert.equal(parseMeasurements("593 million tons")[0].value, 593_000_000);
  });

  it("strips thousands separators and parses bare numbers/years", () => {
    assert.deepEqual(parseMeasurements("1,200 homes"), [
      { value: 1200, unit: "" },
    ]);
    assert.deepEqual(parseMeasurements("by 2030"), [{ value: 2030, unit: "" }]);
  });

  it("does NOT mis-scale a lone letter without a currency (5M users)", () => {
    assert.deepEqual(parseMeasurements("5M users"), [{ value: 5, unit: "" }]);
  });
});

describe("numbersClose", () => {
  it("accepts faithful rounding (~≤3%)", () => {
    assert.equal(numbersClose(29, 28.7), true);
    assert.equal(numbersClose(1.2e9, 1.17e9), true);
    assert.equal(numbersClose(100, 100), true);
  });
  it("rejects larger gaps and magnitude swaps", () => {
    assert.equal(numbersClose(42, 40), false);
    assert.equal(numbersClose(5e6, 5e9), false);
  });
});

describe("measurementsMatch", () => {
  it("matches same unit within tolerance", () => {
    assert.equal(
      measurementsMatch({ value: 29, unit: "%" }, { value: 28.7, unit: "%" }),
      true,
    );
  });
  it("rejects a magnitude swap on the same unit", () => {
    assert.equal(
      measurementsMatch({ value: 5e6, unit: "$" }, { value: 5e9, unit: "$" }),
      false,
    );
  });
  it("rejects a unit mismatch", () => {
    assert.equal(
      measurementsMatch(
        { value: 593, unit: "gw" },
        { value: 593, unit: "ton" },
      ),
      false,
    );
  });

  // Bare unitless figures (years, counts) must match EXACTLY — no rounding
  // tolerance, or "by 2050" would validate "by 2030".
  it("requires bare unitless figures to match exactly (years/counts)", () => {
    assert.equal(
      measurementsMatch({ value: 2030, unit: "" }, { value: 2050, unit: "" }),
      false,
    );
    assert.equal(
      measurementsMatch({ value: 40, unit: "" }, { value: 41, unit: "" }),
      false,
    );
    assert.equal(
      measurementsMatch({ value: 2030, unit: "" }, { value: 2030, unit: "" }),
      true,
    );
  });

  // A bare figure is compatible with a unit-qualified one of equal magnitude,
  // so "5 billion" ↔ "$5 billion" still validates faithful rewrites.
  it("treats a bare figure as compatible with a unit-qualified equal value", () => {
    assert.equal(
      measurementsMatch({ value: 5e9, unit: "$" }, { value: 5e9, unit: "" }),
      true,
    );
  });
});

describe("normalizeNumericToken", () => {
  it("converts trailing 'percent' to '%'", () => {
    assert.equal(normalizeNumericToken("30 percent"), "30%");
  });

  it("strips currency symbols and keeps the decimal", () => {
    assert.equal(normalizeNumericToken("$2.6"), "2.6");
  });

  it("returns null when no digits remain", () => {
    assert.equal(normalizeNumericToken("GW"), null);
    assert.equal(normalizeNumericToken(""), null);
  });
});

/* ================================================================== */
/*  containsQuantifier                                                 */
/* ================================================================== */

describe("containsQuantifier", () => {
  it("detects digits", () => {
    assert.equal(containsQuantifier("30 turbines installed"), true);
  });

  it("detects spelled-out quantifier words", () => {
    assert.equal(containsQuantifier("thirty turbines installed"), true);
    assert.equal(containsQuantifier("a billion dollars committed"), true);
  });

  it("returns false for purely qualitative text", () => {
    assert.equal(containsQuantifier("clean energy expands rapidly"), false);
  });
});

/* ================================================================== */
/*  hasAttribution                                                     */
/* ================================================================== */

describe("hasAttribution", () => {
  it("recognizes common attribution phrasing", () => {
    assert.equal(hasAttribution("Emissions fell sharply, study finds"), true);
    assert.equal(hasAttribution("EPA says rule takes effect in 2027"), true);
    assert.equal(
      hasAttribution("According to researchers, warming accelerated"),
      true,
    );
  });

  it("does not treat bare future/modal verbs as attribution", () => {
    assert.equal(hasAttribution("EPA will finalize the rule"), false);
    assert.equal(hasAttribution("Sea levels could rise faster"), false);
  });
});

/* ================================================================== */
/*  buildSourceQuantContext                                            */
/* ================================================================== */

describe("buildSourceQuantContext", () => {
  it("aggregates numeric + spelled tokens and flags quant evidence", () => {
    const ctx = buildSourceQuantContext([
      "Solar grew 29% to 593GW",
      "about thirty new plants",
    ]);
    assert.equal(ctx.hasQuantEvidence, true);
    assert.ok(ctx.numbers.has("29%"));
    assert.ok(ctx.numbers.has("593"));
    // spelled "thirty" is expanded to "30"
    assert.ok(ctx.numbers.has("30"));
  });

  it("reports no quant evidence and an empty set for qualitative text", () => {
    const ctx = buildSourceQuantContext(["clean energy expands", null, ""]);
    assert.equal(ctx.hasQuantEvidence, false);
    assert.equal(ctx.numbers.size, 0);
  });

  it("handles all-empty input", () => {
    const ctx = buildSourceQuantContext([null, undefined, "  "]);
    assert.equal(ctx.hasQuantEvidence, false);
    assert.equal(ctx.numbers.size, 0);
  });
});

/* ================================================================== */
/*  Validator regex patterns — coverage + documented false positives   */
/* ================================================================== */

describe("CLICKBAIT_PATTERNS", () => {
  it("flags genuine hype/teaser language", () => {
    assert.equal(
      clickbait("This unprecedented breakthrough changes solar"),
      true,
    );
    assert.equal(clickbait("Here's what to know about the new rule"), true);
    assert.equal(clickbait("Will carbon capture finally scale?"), true);
    assert.equal(clickbait("Activists slam new pipeline approval"), true);
  });

  it("leaves a clean Techmeme-style headline alone", () => {
    assert.equal(
      clickbait(
        "EPA finalizes power plant rule requiring 80% CO2 cuts by 2032",
      ),
      false,
    );
  });

  // After tightening /\brip/i → /\brips?\b/i: still catches the combative verb
  // "rip"/"rips" but no longer false-positives on words that merely start with
  // "rip" ("ripe", "ripple").
  it("matches the verb rip/rips but not words that merely start with 'rip'", () => {
    assert.equal(clickbait("Greens rip apart the new drilling rule"), true);
    assert.equal(clickbait("Report rips into utility storm response"), true);
    assert.equal(
      clickbait("Drought leaves ripe crops rotting in fields"),
      false,
    );
    assert.equal(
      clickbait("Tariff change sends ripple through markets"),
      false,
    );
    // Still correct on no-boundary cases:
    assert.equal(clickbait("Cold snap grips the Midwest power grid"), false);
    assert.equal(
      clickbait("Court stripped EPA of authority over emissions"),
      false,
    );
  });
});

describe("WEAK_PATTERNS", () => {
  it("flags hedging verbs", () => {
    assert.equal(weak("EPA will likely finalize the rule"), true);
    assert.equal(weak("Tariffs set to reshape supply chains"), true);
    assert.equal(weak("The plant is poised to double output"), true);
  });

  it("does not flag firm factual phrasing", () => {
    assert.equal(weak("EPA finalized the rule today"), false);
  });
});

describe("VAGUE_PATTERNS", () => {
  it("flags meta-reporting / filler phrasing", () => {
    assert.equal(vague("Report outlines emissions strategy"), true);
    assert.equal(vague("Plan addressing carbon emissions in transport"), true);
    assert.equal(vague("Study raising concerns about deforestation"), true);
    assert.equal(vague("Policy gains traction across the EU"), true);
  });

  it("does not flag concrete action phrasing", () => {
    assert.equal(vague("EU cuts truck CO2 limits by 45% by 2030"), false);
  });
});
