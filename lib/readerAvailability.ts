import { isPaywallUrl } from "@/lib/paywalls";

/**
 * Whether reader mode can show an article — shared by the Preview /
 * Read-now buttons and the reader's prev/next navigation so the card
 * affordance and the arrow flow always agree on what is reachable.
 */
export function isReaderAvailable(
  articleUrl: string,
  contentStatus: string | null | undefined,
  contentWordCount: number | null | undefined,
): boolean {
  // Don't even try known paywall sites
  if (isPaywallUrl(articleUrl)) {
    return false;
  }

  // If we haven't tried fetching yet, assume available
  if (!contentStatus) return true;

  if (["paywall", "blocked", "timeout", "error"].includes(contentStatus)) {
    return false;
  }

  // Too short to be a real article (e.g. minimal HTML from FT);
  // != null so a legacy zero word count doesn't slip through
  if (
    contentStatus === "success" &&
    contentWordCount != null &&
    contentWordCount < 100
  ) {
    return false;
  }

  return true;
}
