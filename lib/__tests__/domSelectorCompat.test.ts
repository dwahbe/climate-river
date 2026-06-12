import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { installSelectorCompat, splitSelectorList } from "../domSelectorCompat";

// The selector that breaks nwsapi (jsdom 22's engine) in Defuddle's cleanup
// list — chained :not(:has()) fails to parse and poisons the whole group.
const BAD_BRANCH = "header:not(:has(p + p)):not(:has(img))";

function makeDom(html: string): JSDOM {
  const dom = new JSDOM(html);
  installSelectorCompat(dom.window);
  return dom;
}

describe("splitSelectorList", () => {
  it("splits a simple group and trims whitespace", () => {
    assert.deepEqual(splitSelectorList("nav, .menu ,#header"), [
      "nav",
      ".menu",
      "#header",
    ]);
  });

  it("keeps commas inside :not() and attribute selectors", () => {
    assert.deepEqual(splitSelectorList('div:not(a, b), [data-x="1,2"], span'), [
      "div:not(a, b)",
      '[data-x="1,2"]',
      "span",
    ]);
  });

  it("handles nested parens and quotes", () => {
    assert.deepEqual(
      splitSelectorList("header:not(:has(p + p)):not(:has(img)), a[href*=',']"),
      ["header:not(:has(p + p)):not(:has(img))", "a[href*=',']"],
    );
  });

  it("returns a single branch for a plain selector", () => {
    assert.deepEqual(splitSelectorList("nav"), ["nav"]);
  });
});

describe("installSelectorCompat", () => {
  const PAGE = `<body>
    <header id="site-header"><a href="/">Logo</a></header>
    <nav id="site-nav"><a href="/a">A</a></nav>
    <div class="menu" id="m1">menu</div>
    <article><p>Real content</p></article>
  </body>`;

  it("querySelectorAll skips unparseable branches instead of throwing", () => {
    const dom = makeDom(PAGE);
    const doc = dom.window.document;
    const matched = doc.querySelectorAll(`${BAD_BRANCH}, nav, .menu`);
    const ids = Array.from(matched).map((el) => el.id);
    assert.deepEqual(ids, ["site-nav", "m1"]);
  });

  it("querySelectorAll returns merged matches in document order", () => {
    const dom = makeDom(PAGE);
    const doc = dom.window.document;
    const matched = doc.querySelectorAll(`.menu, ${BAD_BRANCH}, nav`);
    const ids = Array.from(matched).map((el) => el.id);
    assert.deepEqual(ids, ["site-nav", "m1"]);
  });

  it("querySelector returns the first match across surviving branches", () => {
    const dom = makeDom(PAGE);
    const doc = dom.window.document;
    const el = doc.querySelector(`${BAD_BRANCH}, .menu, nav`);
    assert.equal(el?.id, "site-nav");
  });

  it("matches falls back branch-by-branch", () => {
    const dom = makeDom(PAGE);
    const nav = dom.window.document.getElementById("site-nav")!;
    assert.equal(nav.matches(`${BAD_BRANCH}, nav`), true);
    assert.equal(nav.matches(`${BAD_BRANCH}, .menu`), false);
  });

  it("closest falls back branch-by-branch", () => {
    const dom = makeDom(PAGE);
    const link = dom.window.document.querySelector("#site-nav a")!;
    const hit = link.closest(`${BAD_BRANCH}, nav`);
    assert.equal(hit?.id, "site-nav");
    assert.equal(link.closest(`${BAD_BRANCH}, .menu`), null);
  });

  it("a fully unparseable selector matches nothing instead of throwing", () => {
    const dom = makeDom(PAGE);
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll(BAD_BRANCH).length, 0);
    assert.equal(doc.querySelector(BAD_BRANCH), null);
  });

  it("valid selectors keep native behavior", () => {
    const dom = makeDom(PAGE);
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll("nav, .menu").length, 2);
    assert.equal(doc.querySelector("article p")?.textContent, "Real content");
  });

  it("element-scoped queries work through the fallback", () => {
    const dom = makeDom(PAGE);
    const body = dom.window.document.body;
    const ids = Array.from(body.querySelectorAll(`${BAD_BRANCH}, nav`)).map(
      (el) => el.id,
    );
    assert.deepEqual(ids, ["site-nav"]);
  });
});
