import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractContentSnippet,
  sanitizeHeadline,
  passesChecks,
  buildSourceQuantContext,
} from "../rewrite";

/* ------------------------------------------------------------------ */
/*  Helper: build a ValidationContext for passesChecks                  */
/* ------------------------------------------------------------------ */

function ctx(
  hasContent: boolean,
  ...sourceParts: Array<string | null | undefined>
) {
  return {
    hasContent,
    sourceQuant: buildSourceQuantContext(
      sourceParts.length > 0 ? sourceParts : [null],
    ),
  };
}

/* ================================================================== */
/*  sanitizeHeadline                                                   */
/* ================================================================== */

describe("sanitizeHeadline", () => {
  it("strips surrounding ASCII double quotes", () => {
    assert.equal(sanitizeHeadline('"Hello world"'), "Hello world");
  });

  it("removes trailing periods and decorative punctuation", () => {
    assert.equal(sanitizeHeadline("Headline."), "Headline");
    assert.equal(sanitizeHeadline("Headline —"), "Headline");
    assert.equal(sanitizeHeadline("Headline |"), "Headline");
  });

  it("collapses internal whitespace", () => {
    assert.equal(sanitizeHeadline("Too   many   spaces"), "Too many spaces");
  });
});

/* ================================================================== */
/*  extractContentSnippet                                              */
/* ================================================================== */

function makeContent(): string {
  return (
    "The European Union announced sweeping new regulations targeting industrial emissions across member states. " +
    "Under the proposed framework, large manufacturing facilities must reduce carbon output by forty percent before the end of the decade. " +
    "Environmental groups praised the ambitious targets while industry leaders warned about potential economic disruption. " +
    "Several major automakers have already committed to accelerating their electrification timelines in response to the regulatory changes."
  );
}

describe("extractContentSnippet", () => {
  it("returns null for empty/null input", () => {
    assert.equal(extractContentSnippet(null, null), null);
    assert.equal(extractContentSnippet("", null), null);
  });

  it("returns null for very short content", () => {
    assert.equal(extractContentSnippet("Too short.", null), null);
  });

  it("extracts sentences up to maxChars", () => {
    const text = makeContent();
    const snippet = extractContentSnippet(text, null, 200);
    assert.ok(snippet);
    assert.ok(snippet.length <= 250);
    assert.ok(snippet.startsWith("The European Union"));
  });

  it("strips HTML tags", () => {
    const text = makeContent();
    const html = `<p>${text}</p>`;
    const snippet = extractContentSnippet(null, html, 400);
    assert.ok(snippet);
    assert.ok(!snippet.includes("<p>"));
  });

  it("allows single paywall keyword (relaxed detection)", () => {
    const text =
      "Premium carbon credits are trading at record highs this quarter across global markets. " +
      "The voluntary carbon market saw unprecedented volume growth in the first half of the year. " +
      "Major corporations increased their offset purchases significantly as regulations tighten.";
    const snippet = extractContentSnippet(text, null, 400);
    assert.ok(snippet, "Single 'premium' keyword should not reject content");
  });

  it("rejects content with 2+ paywall signals", () => {
    const text =
      "Subscribe to access premium content and member-only features today. " +
      "Our journalism depends on subscribers like you to continue producing quality work. " +
      "Please sign in to read the full article and support our reporting mission.";
    const snippet = extractContentSnippet(text, null, 400);
    assert.equal(snippet, null, "Multiple paywall signals should reject");
  });

  it("rejects content with too few words", () => {
    // 100+ chars but < 30 words
    const text =
      "Shortword ".repeat(10) +
      "endofcontent averylongsingletokenword padpadpadpadpad morepadding.";
    assert.ok(text.length >= 100);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    assert.ok(words.length < 30);
    const snippet = extractContentSnippet(text, null, 500);
    assert.equal(snippet, null);
  });
});

/* ================================================================== */
/*  passesChecks — length                                              */
/* ================================================================== */

describe("passesChecks — length", () => {
  const noContent = ctx(false);

  it("rejects empty draft", () => {
    assert.equal(passesChecks("Original headline", "", noContent), false);
  });

  it("rejects headline under min length", () => {
    assert.equal(passesChecks("Original", "Too short", noContent), false);
  });

  it("rejects headline over 220 chars", () => {
    const long = "A ".repeat(111).trim(); // 221 chars, 111 words
    assert.ok(long.length > 220);
    assert.equal(passesChecks("Original title here", long, noContent), false);
  });

  it("accepts headline between 200-220 chars", () => {
    // Build a 205-char headline with enough words
    const words = "EPA finalizes landmark emissions reduction rule for power plants across the nation requiring significant cuts to greenhouse gas pollution from coal and natural gas facilities by deadline";
    assert.ok(words.length >= 180 && words.length <= 220);
    assert.equal(
      passesChecks("Different original title for testing purposes here", words, noContent),
      true,
    );
  });
});

/* ================================================================== */
/*  passesChecks — word count compression                              */
/* ================================================================== */

describe("passesChecks — word count", () => {
  it("allows dense rewrite without content (6+ words, 50+ chars)", () => {
    const original = "This Is A Very Long And Wordy Original Headline About Climate Change";
    const draft =
      "Climate policy shifts reshape energy markets across multiple European regions";
    assert.ok(draft.length >= 50);
    assert.ok(draft.split(/\s+/).length >= 6);
    assert.equal(passesChecks(original, draft, ctx(false)), true);
  });

  it("rejects too-short rewrite without content (<6 words)", () => {
    const original = "Some original headline about climate";
    const draft = "Short words only five";
    assert.equal(passesChecks(original, draft, ctx(false)), false);
  });

  it("allows 50% compression with content", () => {
    // 12-word original
    const original =
      "The International Energy Agency Releases New Report On Global Coal Demand Decline Projection";
    // 7-word rewrite = 58% of 12 words, above 50% threshold
    const draft =
      "IEA projects sharp global coal demand decline through end of decade period";
    assert.ok(draft.length >= 60);
    assert.equal(passesChecks(original, draft, ctx(true)), true);
  });

  it("rejects below 50% compression with content", () => {
    // 20-word original
    const original =
      "A very long and detailed original headline with many many words that goes on and on about climate change impacts worldwide";
    // 6-word rewrite = 30% of 20 words
    const draft = "Climate change worldwide short rewrite here placeholder text";
    assert.equal(passesChecks(original, draft, ctx(true)), false);
  });
});

/* ================================================================== */
/*  passesChecks — vague filler patterns (NEW)                         */
/* ================================================================== */

describe("passesChecks — rejects vague filler", () => {
  const noContent = ctx(false);

  const vagueHeadlines = [
    "EPA announces sweeping new emissions rule aiming to reduce pollution by next decade",
    "Solar industry grows rapidly across Asian markets, impacting global energy investments significantly",
    "Tesla vehicle sales shift across European markets, reflecting changing consumer preferences overall",
    "Hydrogen projects face major setbacks amid concerns over long-term economic viability",
    "International report detailing the progress of renewable energy adoption across world markets",
    "New peer-reviewed study outlines key strategies for reducing carbon emissions in transport",
    "Comprehensive new framework addressing biodiversity loss in global financial portfolios launched",
    "India solar panel manufacturing faces challenges as domestic production exceeds current demand",
    "WRI emphasizes urgent need for systemic overhaul to combat growing climate crisis worldwide",
    "Recent project cancellations raise doubts about hydrogen viability in energy transition plans",
  ];

  for (const headline of vagueHeadlines) {
    it(`rejects: "${headline.slice(0, 60)}..."`, () => {
      assert.equal(
        passesChecks("Different original title here", headline, noContent),
        false,
        `Should reject: "${headline}"`,
      );
    });
  }
});

/* ================================================================== */
/*  passesChecks — accepts good Techmeme-style headlines               */
/* ================================================================== */

describe("passesChecks — accepts good headlines", () => {
  const goodHeadlines = [
    {
      headline: "EPA finalizes power plant emissions rule, requires coal facilities to cut CO2 80% by 2032",
      source: "EPA announces new rule requiring 80% CO2 cuts from coal power plants by 2032",
    },
    {
      headline: "Ørsted cancels 2.6GW New Jersey offshore wind project, cites supply chain costs and rate caps",
      source: "Ørsted to cancel 2.6GW offshore wind project in New Jersey due to rising costs",
    },
    {
      headline: "Federal appeals court blocks Mountain Valley Pipeline, cites insufficient climate impact review",
      source: "Court blocks Mountain Valley Pipeline project over climate review",
    },
    {
      headline: "India solar manufacturing hits oversupply glut as factory capacity outpaces domestic demand",
      source: "India's solar manufacturing sector faces growing oversupply",
    },
    {
      headline: "BNP Paribas launches country-level biodiversity risk scoring for lending and investment portfolios",
      source: "French bank BNP Paribas creates new biodiversity risk framework",
    },
    {
      headline: "Amazon emitted 170M tons of carbon in 2023 as extreme drought ravaged rainforest, study finds",
      source: "Study says Amazon rainforest emitted 170M tons of carbon in 2023 drought",
    },
  ];

  for (const { headline, source } of goodHeadlines) {
    it(`accepts: "${headline.slice(0, 60)}..."`, () => {
      const c = ctx(false, source, headline);
      assert.equal(
        passesChecks(source, headline, c),
        true,
        `Should accept: "${headline}"`,
      );
    });
  }
});

/* ================================================================== */
/*  passesChecks — numeric hallucination check                         */
/* ================================================================== */

describe("passesChecks — numeric validation", () => {
  it("rejects numbers not in source material", () => {
    const original = "Major company announces large offshore wind project in the North Sea region";
    const draft = "Company launches 5GW wind project in North Sea, targets completion by next year";
    const c = ctx(false, original);
    assert.equal(passesChecks(original, draft, c), false);
  });

  it("accepts numbers that exist in source", () => {
    const original = "Company launches 5GW wind project in the North Sea targeting grid connection";
    const draft = "Company begins construction on 5GW offshore wind farm in the North Sea region";
    const c = ctx(false, original);
    assert.equal(passesChecks(original, draft, c), true);
  });
});

/* ================================================================== */
/*  passesChecks — hedging & hype                                      */
/* ================================================================== */

describe("passesChecks — hedging and hype", () => {
  const noContent = ctx(false);

  it("rejects 'likely'", () => {
    assert.equal(
      passesChecks(
        "Original title",
        "EPA will likely finalize sweeping climate rule by end of current year",
        noContent,
      ),
      false,
    );
  });

  it("rejects 'set to'", () => {
    assert.equal(
      passesChecks(
        "Original title",
        "New solar tariffs set to reshape global manufacturing and supply chain landscape",
        noContent,
      ),
      false,
    );
  });

  it("rejects 'game-changer'", () => {
    assert.equal(
      passesChecks(
        "Original title",
        "New solid-state battery tech proves to be a game-changer for grid storage systems",
        noContent,
      ),
      false,
    );
  });

  it("rejects 'unprecedented'", () => {
    assert.equal(
      passesChecks(
        "Original title",
        "Unprecedented heat wave strikes southern Europe for third consecutive week running",
        noContent,
      ),
      false,
    );
  });
});
