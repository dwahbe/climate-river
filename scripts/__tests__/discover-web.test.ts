import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rootDomain } from "../discover-web";

describe("rootDomain", () => {
  it("returns two-part domains unchanged", () => {
    assert.equal(rootDomain("canarymedia.com"), "canarymedia.com");
    assert.equal(rootDomain("rmi.org"), "rmi.org");
  });

  it("strips subdomains to root domain", () => {
    assert.equal(rootDomain("assets.canarymedia.com"), "canarymedia.com");
    assert.equal(rootDomain("energy.canarymedia.com"), "canarymedia.com");
    assert.equal(rootDomain("pdf.wri.org"), "wri.org");
    assert.equal(rootDomain("publications.wri.org"), "wri.org");
    assert.equal(rootDomain("utilitytransitionhub.rmi.org"), "rmi.org");
  });

  it("strips deeply nested subdomains", () => {
    assert.equal(rootDomain("a.b.c.example.com"), "example.com");
  });

  it("handles compound TLDs correctly", () => {
    assert.equal(rootDomain("downtoearth.org.in"), "downtoearth.org.in");
    assert.equal(rootDomain("sub.downtoearth.org.in"), "downtoearth.org.in");
    assert.equal(rootDomain("bbc.co.uk"), "bbc.co.uk");
    assert.equal(rootDomain("news.bbc.co.uk"), "bbc.co.uk");
  });

  it("handles single-part input gracefully", () => {
    assert.equal(rootDomain("localhost"), "localhost");
  });
});
