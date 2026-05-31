import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isClimateRelevant } from "../tagger";

/**
 * isClimateRelevant() is the gate that decides what enters the river at
 * ingestion (scripts/ingest.ts) and what is rewritten/categorized. It is a
 * pure regex keyword gate; the source code itself flags it as prone to false
 * positives/negatives. These tests pin its behavior and document the known
 * false positives empirically observed against production data.
 */

describe("isClimateRelevant — true positives", () => {
  const climate = [
    "COP30 nations agree to phase down coal use by 2035",
    "Wildfire smoke blankets the West Coast as drought deepens",
    "EPA finalizes methane rule for oil and gas operators",
    "Offshore wind farm clears final federal permit",
    "Study links ocean warming to coral bleaching surge",
  ];
  for (const title of climate) {
    it(`accepts: "${title.slice(0, 48)}..."`, () => {
      assert.equal(isClimateRelevant({ title }), true);
    });
  }

  it("considers the summary, not just the title", () => {
    assert.equal(
      isClimateRelevant({
        title: "Local council approves new development",
        summary:
          "The board cleared a 200MW solar farm and battery storage site.",
      }),
      true,
    );
  });
});

describe("isClimateRelevant — true negatives", () => {
  const nonClimate = [
    "Lakers beat Celtics in overtime thriller",
    "Apple unveils new iPhone with faster chip",
    "Stock market rallies on strong jobs report",
    "City reschedules the annual food festival",
  ];
  for (const title of nonClimate) {
    it(`rejects: "${title.slice(0, 48)}..."`, () => {
      assert.equal(isClimateRelevant({ title }), false);
    });
  }

  it("returns false for empty/whitespace input", () => {
    assert.equal(isClimateRelevant({ title: "" }), false);
    assert.equal(isClimateRelevant({ title: "   " }), false);
  });

  it("drops 'Current conditions:' roundup boilerplate before scoring", () => {
    // The only climate-ish words live in a weather-roundup summary that
    // cleanCategorizationSummary() strips, so the article is correctly excluded.
    assert.equal(
      isClimateRelevant({
        title: "Town hall meeting recap",
        summary: "Current conditions: a heat dome is parked over the region.",
      }),
      false,
    );
  });
});

describe("isClimateRelevant — formerly false positives, now rejected", () => {
  // After moving bare ambiguous words (heat/mining/gas/oil/energy/wind) behind a
  // required climate-context cue, these unrelated stories are correctly excluded.
  const rejected = [
    "Miami Heat win in overtime thriller", // dropped bare "heat"
    "Mining stocks rally on strong demand", // "mining" w/o climate context
    "Gas station prices tick up ahead of holiday travel", // bare "gas"
    "Oil prices jump on Middle East tensions", // bare "oil"
    "Bitcoin mining firm reports record quarter", // "mining" w/o context
    "Wind blows away parade balloons downtown", // bare "wind"
    "New energy drink launches nationwide", // bare "energy"
  ];
  for (const title of rejected) {
    it(`rejects: "${title.slice(0, 48)}..."`, () => {
      assert.equal(isClimateRelevant({ title }), false);
    });
  }

  it("still keeps ambiguous terms WITH a climate cue", () => {
    // "oil"/"gas"/"mining" remain relevant when a climate/energy cue co-occurs.
    assert.equal(
      isClimateRelevant({
        title: "Oil giant slashes emissions target amid climate pressure",
      }),
      true,
    );
    assert.equal(
      isClimateRelevant({
        title: "Coal mine expansion draws fossil-fuel divestment push",
      }),
      true,
    );
    assert.equal(
      isClimateRelevant({
        title: "Gas demand falls as renewables overtake the power grid",
      }),
      true,
    );
  });
});

describe("isClimateRelevant — category coverage (recall guard)", () => {
  // One representative headline per editorial lane, to ensure the tightened gate
  // did not cost recall on genuine climate coverage.
  const byLane: Array<[string, string]> = [
    [
      "government",
      "Senate passes sweeping climate bill with $369B in clean-energy incentives",
    ],
    [
      "business",
      "BlackRock launches green bond fund targeting net-zero portfolios",
    ],
    [
      "research",
      "New study projects the 1.5C warming threshold will be breached by 2030",
    ],
    ["tech", "Form Energy unveils 100-hour iron-air battery for grid storage"],
    [
      "activism",
      "Extinction Rebellion blockades a refinery in a climate protest",
    ],
    [
      "impacts",
      "Record floods displace thousands across Pakistan as monsoon intensifies",
    ],
  ];
  for (const [lane, title] of byLane) {
    it(`keeps ${lane}: "${title.slice(0, 40)}..."`, () => {
      assert.equal(isClimateRelevant({ title }), true);
    });
  }
});

describe("isClimateRelevant — recall restored after production scan", () => {
  // Real headlines that an over-strict gate wrongly dropped (found by scanning
  // production data). These must now be kept.
  const kept = [
    "An Easier Path To Heat Pumps: Monthly Payments, No Up-Front Cost", // heat pump
    "UK and Europe shatter heat records in 'mind-boggling' May", // heat + records
    "Heat stress increases koala hospitalisation and mortality: Study", // heat + stress
    "Seven deaths in France linked to record-high temperatures", // temperatures + record/deaths
    "Brussels presses oil and gas majors to move faster on CO2 storage targets", // CO2
    "The wind boom Trump couldn't stop", // wind (energy)
    "Why repowering wind is key to meeting the AI power surge", // wind (energy)
    "When Oil Shocks Hit Home: Why Africa's Buses Must Go Electric", // go electric
    "Becerra won't commit to California's 2035 gas car sales ban", // gas car
    "Spain wins EU nod for €9 bln electricity backup scheme", // electricity
    "AI is turning energy into the hottest business in America", // energy
    "Cadmium Telluride - Department of Energy", // energy / solar PV material
  ];
  for (const title of kept) {
    it(`keeps: "${title.slice(0, 46)}..."`, () => {
      assert.equal(isClimateRelevant({ title }), true);
    });
  }

  // Precision preserved: weather power-outages and sports "heat" still excluded.
  const stillRejected = [
    "Thousands lose power in Massachusetts after wind gusts bring down trees", // weather, not wind energy
    "More than 4,500 residents lose power as wind knocks down trees", // weather
    "What to know about the heat policy at the French Open", // sports heat, no weather cue
  ];
  for (const title of stillRejected) {
    it(`rejects: "${title.slice(0, 46)}..."`, () => {
      assert.equal(isClimateRelevant({ title }), false);
    });
  }
});
