// lib/utils.ts
// General-purpose utilities shared across pipeline scripts.

// ---------- RSS <source> element parsing ----------

export type RssSourceField =
  | string
  | {
      ["#"]?: string;
      _?: string;
      text?: string;
      value?: string;
      $?: {
        url?: string;
      };
      url?: string;
    };

export function decodeHtmlEntities(s: string) {
  return (s || "")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Extract publisher name and homepage from an RSS item's <source> element.
 * Falls back to parsing the title suffix pattern "Title — Publisher".
 */
export function extractPublisherFromRssItem(item: {
  title?: string;
  source?: RssSourceField | RssSourceField[];
}): { name?: string; homepage?: string } {
  const src = item.source;
  const first = Array.isArray(src) ? src[0] : src;
  if (typeof first === "string") {
    const trimmed = first.trim();
    if (trimmed) return { name: decodeHtmlEntities(trimmed) };
  } else if (first && typeof first === "object") {
    const rawName =
      (typeof first["#"] === "string" && first["#"]) ||
      (typeof first._ === "string" && first._) ||
      (typeof first.text === "string" && first.text) ||
      (typeof first.value === "string" && first.value) ||
      undefined;
    const homepage =
      (typeof first.$?.url === "string" && first.$.url) ||
      (typeof first.url === "string" && first.url) ||
      undefined;
    if (rawName || homepage) {
      return {
        name: rawName ? decodeHtmlEntities(rawName.trim()) : undefined,
        homepage,
      };
    }
  }

  // Fallback: title suffix like "Title — Publisher"
  if (item.title) {
    const m = item.title.match(/\s[-—]\s([^]+)$/);
    if (m) {
      const name = decodeHtmlEntities(m[1].trim());
      const homepage = /\b[a-z0-9.-]+\.[a-z]{2,}\b/i.test(name)
        ? `https://${name}`
        : undefined;
      return { name, homepage };
    }
  }
  return {};
}

// ---------- URL utilities ----------

const TRACKING_PARAMS = /^utm_|^fbclid$|^gclid$|^mc_|^ved$|^usg$|^oc$|^si$/i;

/**
 * Strip tracking params (UTM, Google, Facebook) and hash fragment from a URL.
 * Returns the original string on parse failure.
 */
export function canonical(url: string): string {
  try {
    const u = new URL(url);
    [...u.searchParams.keys()].forEach((k) => {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    });
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Concurrency-limited Promise.all.
 * Processes `items` through `fn` with at most `limit` concurrent operations.
 * Results maintain insertion order.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let i = 0,
    active = 0;
  return new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(ret);
      while (active < limit && i < items.length) {
        const cur = i++;
        active++;
        fn(items[cur], cur)
          .then((v) => (ret[cur] = v))
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

/**
 * Remove trailing " - Source Name" or " — Source Name" from Google News titles.
 * Handles both hyphens and em-dashes.
 */
export function cleanGoogleNewsTitle(title: string): string {
  return title.replace(/\s[-—]\s[^-—]+$/, "").trim();
}

/**
 * Validate that a date is reasonable for a news article.
 * Rejects future dates, suspiciously-close-to-now dates, and dates older than maxAgeDays.
 */
export function isValidArticleDate(
  date: Date | null,
  maxAgeDays = 30,
): { valid: boolean; reason?: string } {
  if (!date) return { valid: false, reason: "missing date" };

  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  const oneMinuteFromNow = new Date(now.getTime() + 60 * 1000);

  if (date > oneMinuteFromNow) {
    return { valid: false, reason: `future date: ${date.toISOString()}` };
  }

  if (Math.abs(date.getTime() - now.getTime()) < 30 * 1000) {
    return {
      valid: false,
      reason:
        "date suspiciously close to current time (likely parsing failure)",
    };
  }

  if (date < cutoff) {
    return { valid: false, reason: `too old: ${date.toISOString()}` };
  }

  return { valid: true };
}
