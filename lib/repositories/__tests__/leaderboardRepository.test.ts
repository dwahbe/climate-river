import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeRankChanges, type RawRow } from "../leaderboardRepository";

function row(overrides: Partial<RawRow> & Pick<RawRow, "rank_key">): RawRow {
  return {
    name: "Test",
    homepage: "https://example.com",
    leads: 10,
    articles: 5,
    ...overrides,
  };
}

describe("computeRankChanges", () => {
  it("matches current and previous rows by rankKey, not raw homepage", () => {
    const current = [
      row({
        rank_key: "host:nytimes.com",
        name: "New York Times",
        homepage: "https://nytimes.com",
        leads: 50,
      }),
    ];
    const previous = [
      row({
        rank_key: "host:nytimes.com",
        name: "NYT",
        homepage: "https://www.nytimes.com", // different homepage format
        leads: 40,
      }),
      row({
        rank_key: "host:reuters.com",
        name: "Reuters",
        homepage: "https://reuters.com",
        leads: 30,
      }),
    ];

    const entries = computeRankChanges(current, previous);

    assert.equal(entries.length, 1);
    // NYT was rank 1 in previous, rank 1 in current → change = 0
    assert.equal(entries[0].change, 0);
    assert.equal(entries[0].name, "New York Times");
  });

  it("homepage changes do not create false NEW entries", () => {
    const current = [
      row({
        rank_key: "host:theguardian.com",
        name: "The Guardian",
        homepage: "https://theguardian.com",
      }),
    ];
    const previous = [
      row({
        rank_key: "host:theguardian.com",
        name: "The Guardian",
        homepage: "https://www.theguardian.com", // different homepage
      }),
    ];

    const entries = computeRankChanges(current, previous);

    assert.equal(entries.length, 1);
    assert.notEqual(entries[0].change, null);
    assert.equal(entries[0].change, 0);
  });

  it("returns change = null for entries not in previous period", () => {
    const current = [
      row({
        rank_key: "host:carbonpulse.com",
        name: "Carbon Pulse",
        leads: 100,
      }),
    ];

    const entries = computeRankChanges(current, []);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].change, null);
  });

  it("does not expose rankKey in returned entries", () => {
    const current = [row({ rank_key: "host:example.com", name: "Example" })];

    const entries = computeRankChanges(current, []);

    assert.equal(entries.length, 1);
    assert.deepEqual(Object.keys(entries[0]).sort(), [
      "articles",
      "change",
      "homepage",
      "leads",
      "name",
    ]);
    assert.equal("rank_key" in entries[0], false);
  });

  it("computes positive change when outlet moves up", () => {
    const current = [
      row({ rank_key: "host:a.com", name: "A", leads: 50 }),
      row({ rank_key: "host:b.com", name: "B", leads: 40 }),
    ];
    const previous = [
      row({ rank_key: "host:b.com", name: "B", leads: 50 }),
      row({ rank_key: "host:a.com", name: "A", leads: 40 }),
    ];

    const entries = computeRankChanges(current, previous);

    // A moved from rank 2 → rank 1 = change +1
    assert.equal(entries[0].name, "A");
    assert.equal(entries[0].change, 1);
    // B moved from rank 1 → rank 2 = change -1
    assert.equal(entries[1].name, "B");
    assert.equal(entries[1].change, -1);
  });

  it("handles name-based rankKey for outlets without a homepage", () => {
    const current = [
      row({
        rank_key: "name:some outlet",
        name: "Some Outlet",
        homepage: "",
        leads: 20,
      }),
    ];
    const previous = [
      row({
        rank_key: "name:other outlet",
        name: "Other Outlet",
        homepage: "",
        leads: 30,
      }),
      row({
        rank_key: "name:some outlet",
        name: "Some Outlet",
        homepage: "",
        leads: 15,
      }),
    ];

    const entries = computeRankChanges(current, previous);

    assert.equal(entries.length, 1);
    // Was rank 2, now rank 1 → change = +1
    assert.equal(entries[0].change, 1);
  });
});
