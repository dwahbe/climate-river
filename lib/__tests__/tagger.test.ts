import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { categorizeArticle, cleanCategorizationSummary } from "../tagger";

function slugsFor(title: string, summary?: string | null): string[] {
  return categorizeArticle({ title, summary }).map((score) => score.slug);
}

describe("categorizeArticle", () => {
  it("does not treat dates, markets, disruption, or blockades as activism", () => {
    const examples = [
      {
        title:
          "Arctic winter sea-ice extent fails to expand and sets a new record low in 2026",
        summary:
          "The annual maximum reached a record low after the previous record in March 2025.",
      },
      {
        title:
          "How LNG interests are seeking to disrupt global talks on decarbonising shipping",
        summary:
          "Observers say pressure appears linked to countries with major gas investments.",
      },
      {
        title:
          "RGGI Allowance futures surge over 30% in three days as historic rally extends",
        summary: "Carbon prices broke all-time highs above the $40 threshold.",
      },
      {
        title:
          "Exclusive: Trump rejects Iran's offer, says blockade stays until nuclear deal",
        summary:
          "The naval blockade will remain until the regime agrees to a deal.",
      },
    ];

    for (const example of examples) {
      assert.equal(
        slugsFor(example.title, example.summary).includes("justice"),
        false,
      );
    }
  });

  it("keeps real climate activism signals", () => {
    const slugs = slugsFor(
      "Climate activists blockade pipeline construction after mass rally",
      "Protesters from a grassroots movement said the direct action targets fossil fuel expansion.",
    );

    assert.equal(slugs.includes("justice"), true);
  });

  it("does not treat NGO reports or social activists as climate activism", () => {
    const examples = [
      {
        title:
          "Delaying coal phase-out could cost South Africa $38 billion in health-related economic losses: Greenpeace report",
        summary:
          "A new report warns that delaying the phase-out of coal-fired power will carry serious health and economic consequences.",
      },
      {
        title:
          "Murlidhar Devidas Amte describes central India belt as poverty's own republic",
        summary:
          "The social activist referred to the forest belt as the country's cummerbund.",
      },
    ];

    for (const example of examples) {
      assert.equal(
        slugsFor(example.title, example.summary).includes("justice"),
        false,
      );
    }
  });

  it("categorizes wildlife climate impacts without activism leakage", () => {
    const slugs = slugsFor(
      "One night a year, humans command this march of frogs and salamanders",
      "Warming winters and drying pools are disrupting annual amphibian migration.",
    );

    assert.equal(slugs.includes("impacts"), true);
    assert.equal(slugs.includes("justice"), false);
  });

  it("drops roundup boilerplate before category scoring", () => {
    const dirtySummary =
      "Current conditions: A polar vortex chill is over. A winter storm is blanketing the Sierra Nevadas.";

    const slugs = slugsFor(
      "Trump Halts Construction on Onshore Wind Turbines",
      dirtySummary,
    );

    assert.equal(cleanCategorizationSummary(dirtySummary), undefined);
    assert.equal(slugs.includes("impacts"), false);
    assert.equal(slugs.includes("tech"), true);
  });

  it("removes publisher DOI boilerplate without losing useful study context", () => {
    const clean = cleanCategorizationSummary(
      "Nature, Published online: 30 April 2026; doi:10.1038/s41586-026-10587-4 Continuously graded-doped SnO2 for efficient n-i-p perovskite solar cells",
    );

    assert.equal(
      clean,
      "Continuously graded-doped SnO2 for efficient n-i-p perovskite solar cells",
    );
  });

  it("does not classify non-climate Nature science as climate research", () => {
    const slugs = slugsFor(
      "Nature reveals intrinsic 2D polar vortex crystals in A-site layer-ordered perovskites",
      "Nature, Published online: 29 April 2026; doi:10.1038/s41586-026-10470-2 Stable topological ferroelectric states form without external constraints.",
    );

    assert.deepEqual(slugs, []);
  });

  it("keeps solar-cell research in climate categories", () => {
    const slugs = slugsFor(
      "Nature publishes study on continuously graded-doped SnO2 enhancing efficiency of n-i-p perovskite solar cells",
      "Nature, Published online: 30 April 2026; doi:10.1038/s41586-026-10587-4 Continuously graded-doped SnO2 for efficient n-i-p perovskite solar cells",
    );

    assert.equal(slugs.includes("research"), true);
    assert.equal(slugs.includes("tech"), true);
  });

  it("does not treat offshore oil and gas water wording as climate impacts", () => {
    const slugs = slugsFor(
      "Southeast Asia launches Deepwater 2.0 drive targeting 28 tcf gas in Indonesia, Malaysia, and Brunei",
      "The drive aims to replace declining shallow-water and onshore gas production.",
    );

    assert.equal(slugs.includes("impacts"), false);
  });

  it("does not treat wildlife park news as climate impacts because of a forest place name", () => {
    const slugs = slugsFor(
      "Wildlife park welcomes three male Asiatic lions",
      "There are about 500 to 600 Asiatic lions left in the wild which only live in Gir Forest, India.",
    );

    assert.deepEqual(slugs, []);
  });

  it("does not treat the phrase crops up as agricultural climate impacts", () => {
    const slugs = slugsFor(
      "Hantavirus crops up on a cruise ship — what scientists are watching",
      "The group of rodent viruses can cause disease in humans, but cases are rare.",
    );

    assert.deepEqual(slugs, []);
  });

  it("keeps crop damage stories in impacts", () => {
    const [primary] = slugsFor(
      "NOAA warns Super El Niño could raise energy demand and damage crops across Asia",
      "Forecasters warned higher temperatures and reduced hydropower could hurt crop production.",
    );

    assert.equal(primary, "impacts");
  });

  it("classifies climate summits as government rather than clean tech", () => {
    const [primary] = slugsFor(
      "‘Historic breakthrough’: could the fossil fuel era be coming to an end? – podcast",
      "The transition towards renewable energy received a boost last week when representatives from 57 countries met in Santa Marta, Colombia, for a world-first climate meeting aimed at bringing the fossil fuels era to an end.",
    );

    assert.equal(primary, "government");
  });

  it("keeps fossil-fuel phase-out summit coverage in government despite renewable energy wording", () => {
    const [primary] = slugsFor(
      "As Energy, War and Climate Collide, A Climate Summit in Colombia Charts a Path Beyond Fossil Fuels",
      "More than 50 countries at the first Conference on Transitioning Away From Fossil Fuels began developing plans to shift toward renewable energy systems.",
    );

    assert.equal(primary, "government");
  });

  it("classifies UN Article 6.4 registry rules as government, not research", () => {
    const [primary] = slugsFor(
      "UN publishes draft Article 6.4 registry rules as PACM edges closer to full operation",
      "Experts working to operationalise the UN's Paris Agreement Crediting Mechanism have published a new draft registry procedure that will be considered by the Article 6.4 Supervisory Body.",
    );

    assert.equal(primary, "government");
  });

  it("recognizes researchers detecting climate impacts as research", () => {
    const [primary] = slugsFor(
      "Researchers detect microplastics in Amazon frog tadpoles and pond habitats in the wild for the first time",
      "Researchers recorded microplastics in frog tadpoles and their pond habitats in the Amazon, according to a new study.",
    );

    assert.equal(primary, "research");
  });
});
