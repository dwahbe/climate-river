// lib/utils.ts
// General-purpose utilities shared across pipeline scripts.

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
