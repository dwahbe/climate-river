import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { linkTextDensity } from "../readerService";

const NAV_JUNK = `<ul>
  <li><a href="https://example.com/">Example Premium</a></li>
  <li><a href="https://example.com/about">About Us</a></li>
  <li><a href="https://example.com/staff">Staff</a></li>
  <li><a href="https://example.com/register">Register</a></li>
  <li><a href="https://example.com/login">Log in</a></li>
</ul>`;

const ARTICLE = `<p>Ten officials are calling on the government to immediately
release the advocate, who has been jailed for six months ahead of a key court
hearing. The case has drawn international attention from
<a href="https://example.com/groups">several human rights groups</a> this
year.</p>
<p>Supporters say the charges misrepresent everyday advocacy work carried out
through official channels for many years.</p>`;

function wordCount(html: string): number {
  return html
    .replace(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

describe("linkTextDensity", () => {
  it("flags nav-link junk as fully link-dominated", () => {
    const density = linkTextDensity(NAV_JUNK, wordCount(NAV_JUNK));
    assert.ok(density > 0.9, `expected > 0.9, got ${density}`);
  });

  it("keeps real articles with inline links well below the limit", () => {
    const density = linkTextDensity(ARTICLE, wordCount(ARTICLE));
    assert.ok(density < 0.2, `expected < 0.2, got ${density}`);
  });

  it("returns 0 for content without links or words", () => {
    assert.equal(linkTextDensity("<p>plain text</p>", 2), 0);
    assert.equal(linkTextDensity("", 0), 0);
  });

  it("counts words in nested markup inside anchors", () => {
    const html = `<p>x <a href="/a"><span>two <b>words</b></span></a></p>`;
    assert.equal(linkTextDensity(html, 3), 2 / 3);
  });
});
