import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTrustedClimateHost,
  isTrustedClimateFeed,
  isTrustedClimateSource,
} from "../../config/trustedClimateSources";

describe("trustedClimateSources — hosts", () => {
  it("matches trusted hosts and their subdomains", () => {
    assert.equal(isTrustedClimateHost("grist.org"), true);
    assert.equal(
      isTrustedClimateHost("https://www.heatmap.news/energy/x"),
      true,
    );
    assert.equal(isTrustedClimateHost("india.carbonbrief.org"), true);
    assert.equal(isTrustedClimateHost("HEATMAP.NEWS"), true);
  });
  it("rejects general outlets and lookalikes", () => {
    assert.equal(isTrustedClimateHost("theguardian.com"), false);
    assert.equal(isTrustedClimateHost("nytimes.com"), false);
    assert.equal(isTrustedClimateHost("notgrist.org"), false);
    assert.equal(isTrustedClimateHost("grist.org.evil.com"), false);
    assert.equal(isTrustedClimateHost(""), false);
    assert.equal(isTrustedClimateHost(null), false);
  });
});

describe("trustedClimateSources — section feeds of general outlets", () => {
  it("trusts Guardian climate/energy subsection feeds only", () => {
    assert.equal(
      isTrustedClimateFeed(
        "https://www.theguardian.com/environment/climate-crisis/rss",
      ),
      true,
    );
    assert.equal(
      isTrustedClimateFeed(
        "https://www.theguardian.com/environment/energy/rss",
      ),
      true,
    );
    assert.equal(
      isTrustedClimateFeed(
        "https://www.theguardian.com/environment/fossil-fuels/rss",
      ),
      true,
    );
    // Broad environment desk carries wildlife/outdoors → stays gated
    assert.equal(
      isTrustedClimateFeed("https://www.theguardian.com/us/environment/rss"),
      false,
    );
    assert.equal(
      isTrustedClimateFeed("https://www.theguardian.com/environment/rss"),
      false,
    );
    assert.equal(
      isTrustedClimateFeed("https://www.theguardian.com/us/rss"),
      false,
    );
    assert.equal(
      isTrustedClimateFeed("https://www.theguardian.com/world/rss"),
      false,
    );
  });
  it("NYT Climate.xml (climate AND environment desk) stays gated", () => {
    assert.equal(
      isTrustedClimateFeed(
        "https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml",
      ),
      false,
    );
    assert.equal(
      isTrustedClimateFeed(
        "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
      ),
      false,
    );
  });
});

describe("trustedClimateSources — isTrustedClimateSource", () => {
  it("a feed on a trusted host is trusted regardless of path", () => {
    assert.equal(
      isTrustedClimateSource({ feedUrl: "https://grist.org/feed/" }),
      true,
    );
    assert.equal(
      isTrustedClimateSource({
        feedUrl: "https://heatmap.news/feeds/feed.rss",
      }),
      true,
    );
  });
  it("general feeds stay gated even when the homepage is passed", () => {
    assert.equal(
      isTrustedClimateSource({
        feedUrl: "https://www.theguardian.com/us/rss",
        homepageUrl: "https://theguardian.com",
      }),
      false,
    );
  });
  it("discovery pseudo-sources (discover:// / web://) are trusted by host, like the articles they hold", () => {
    assert.equal(
      isTrustedClimateSource({
        feedUrl: "discover://grist.org",
        homepageUrl: "https://grist.org",
      }),
      true,
    );
    assert.equal(
      isTrustedClimateSource({ feedUrl: "web://heatmap.news" }),
      true,
    );
    assert.equal(
      isTrustedClimateSource({
        feedUrl: "discover://theguardian.com",
        homepageUrl: "https://theguardian.com",
      }),
      false,
    );
  });
  it("discovered articles are trusted by URL host", () => {
    assert.equal(
      isTrustedClimateSource({
        url: "https://www.canarymedia.com/articles/ev/x",
      }),
      true,
    );
    assert.equal(
      isTrustedClimateSource({ url: "https://www.reuters.com/business/x" }),
      false,
    );
  });
});
