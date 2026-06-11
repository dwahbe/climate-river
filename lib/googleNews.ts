// lib/googleNews.ts
// Resolution of Google News redirect URLs (news.google.com/rss/articles/<token>)
// to the real publisher URL. Layered strategy:
//   1. legacy `?url=` query param (oldest format)
//   2. legacy base64 token that embeds the URL directly (pre-2024 "CBMi…" tokens)
//   3. Google's internal batchexecute endpoint (current opaque tokens)
// Every network call goes through safeFetch (SSRF guard). All failures are
// graceful: callers get `null` and keep the aggregator URL, which downstream
// code treats as lead-ineligible.

import { safeFetch } from "./urlSafety";
import { isAggregatorHost, isAggregatorUrl } from "./aggregators";

export { isAggregatorHost, isAggregatorUrl };

/** Extract the GN article token from /articles/<token> or /rss/articles/<token>. */
export function extractGoogleNewsToken(link: string): string | null {
  try {
    const u = new URL(link);
    if (!u.hostname.endsWith("news.google.com")) return null;
    const m = u.pathname.match(/\/(?:rss\/)?articles\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Pre-2024 tokens base64-encode a protobuf that embeds the article URL as a
 * readable ASCII run. Decode and extract the first plausible http(s) URL.
 */
export function decodeLegacyGoogleNewsToken(token: string): string | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  const ascii = bytes.toString("latin1");
  const start = ascii.indexOf("http");
  if (start === -1) return null;

  let end = start;
  while (end < ascii.length) {
    const code = ascii.charCodeAt(end);
    if (code < 0x21 || code > 0x7e) break;
    end++;
  }
  const candidate = ascii.slice(start, end);
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname.endsWith("news.google.com")) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Pull the signature/timestamp the batchexecute call needs from the article page. */
export function extractBatchParams(
  html: string,
): { signature: string; timestamp: string } | null {
  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="(\d+)"/);
  if (!sg || !ts) return null;
  return { signature: sg[1], timestamp: ts[1] };
}

export function buildBatchexecuteBody(
  token: string,
  signature: string,
  timestamp: string,
): string {
  const inner = JSON.stringify([
    "garturlreq",
    [
      [
        "X",
        "X",
        ["X", "X"],
        null,
        null,
        1,
        1,
        "US:en",
        null,
        1,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
      ],
      "X",
      "X",
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    token,
    Number(timestamp),
    signature,
  ]);
  const fReq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
  return "f.req=" + encodeURIComponent(fReq);
}

/** Parse the )]}'-prefixed batchexecute response and pull out the article URL. */
export function parseBatchexecuteResponse(text: string): string | null {
  // Robust path: locate the escaped garturlres payload directly.
  const direct = text.match(/garturlres\\",\\"(https?:[^"\\]+)/);
  if (direct) return direct[1];

  // Structured path: parse each JSON-looking line and unwrap the inner string.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[[")) continue;
    try {
      const outer = JSON.parse(trimmed) as unknown[][];
      for (const entry of outer) {
        if (!Array.isArray(entry) || entry[1] !== "Fbv4je") continue;
        const payload = entry[2];
        if (typeof payload !== "string") continue;
        const innerArr = JSON.parse(payload) as unknown[];
        if (innerArr[0] === "garturlres" && typeof innerArr[1] === "string") {
          return innerArr[1];
        }
      }
    } catch {
      // not this line
    }
  }
  return null;
}

export type GoogleNewsResolution = {
  url: string | null;
  method: "passthrough" | "url_param" | "legacy_token" | "api" | null;
};

const GN_PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; ClimateRiverBot/0.1; +https://climateriver.org)",
  Accept: "text/html,application/xhtml+xml",
  // Bypass the EU consent interstitial.
  Cookie:
    "CONSENT=YES+cb; SOCS=CAESHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyaBg",
};

/**
 * Resolve a Google News link to the publisher URL. Non-GN links pass through
 * unchanged. Returns `{ url: null }` when resolution fails — callers keep the
 * aggregator URL and downstream treats the article as lead-ineligible.
 */
export async function resolveGoogleNewsUrl(
  link: string,
  opts: { timeoutMs?: number } = {},
): Promise<GoogleNewsResolution> {
  const timeoutMs = opts.timeoutMs ?? 8_000;

  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return { url: null, method: null };
  }
  if (!parsed.hostname.endsWith("news.google.com")) {
    return { url: link, method: "passthrough" };
  }

  const fromParam = parsed.searchParams.get("url");
  if (fromParam && !isAggregatorUrl(fromParam)) {
    return { url: fromParam, method: "url_param" };
  }

  const token = extractGoogleNewsToken(link);
  if (!token) return { url: null, method: null };

  const fromToken = decodeLegacyGoogleNewsToken(token);
  if (fromToken) return { url: fromToken, method: "legacy_token" };

  // Current opaque tokens: fetch the article page for the signed params, then
  // ask the internal endpoint for the destination. Google can change this at
  // any time — failures degrade gracefully to "unresolved".
  try {
    const pageRes = await safeFetch(
      `https://news.google.com/rss/articles/${encodeURIComponent(token)}?hl=en-US&gl=US&ceid=US:en`,
      { headers: GN_PAGE_HEADERS, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!pageRes.ok) return { url: null, method: null };
    const params = extractBatchParams(await pageRes.text());
    if (!params) return { url: null, method: null };

    const apiRes = await safeFetch(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute",
      {
        method: "POST",
        headers: {
          ...GN_PAGE_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: buildBatchexecuteBody(token, params.signature, params.timestamp),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!apiRes.ok) return { url: null, method: null };
    const resolved = parseBatchexecuteResponse(await apiRes.text());
    if (resolved && !isAggregatorUrl(resolved)) {
      return { url: resolved, method: "api" };
    }
    return { url: null, method: null };
  } catch {
    return { url: null, method: null };
  }
}
