import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isLowValueHost,
  isLowValueUrl,
  LOW_VALUE_URL_SQL_REGEX,
} from "../aggregators";

describe("LOW_VALUE_HOSTS — content farms, PR wires, stock sites", () => {
  it("matches listed hosts and subdomains", () => {
    assert.equal(isLowValueHost("thecooldown.com"), true);
    assert.equal(isLowValueHost("www.prnewswire.com"), true);
    assert.equal(isLowValueHost("finance.yahoo.com"), true);
    assert.equal(isLowValueUrl("https://sg.finance.yahoo.com/news/x"), true);
    assert.equal(isLowValueUrl("https://www.fool.com/investing/x"), true);
  });
  it("does not match real publishers or lookalikes", () => {
    assert.equal(isLowValueHost("grist.org"), false);
    assert.equal(isLowValueHost("reuters.com"), false);
    assert.equal(isLowValueHost("notfool.com"), false);
    assert.equal(isLowValueUrl("https://www.theguardian.com/x"), false);
    assert.equal(isLowValueUrl("not a url"), false);
  });
  it("SQL regex is host-anchored (JS-evaluated approximation of POSIX ~*)", () => {
    const re = new RegExp(LOW_VALUE_URL_SQL_REGEX, "i");
    assert.equal(re.test("https://www.thecooldown.com/outdoors/x"), true);
    assert.equal(re.test("https://finance.yahoo.com/news/x"), true);
    assert.equal(re.test("https://www.reuters.com/x?via=fool.com"), false);
    assert.equal(re.test("https://notfool.com/x"), false);
    assert.equal(re.test("https://grist.org/x"), false);
  });
});
