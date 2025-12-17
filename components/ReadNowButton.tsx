"use client";

import { useState } from "react";
import ReaderView from "./ReaderView";

type ReadNowButtonProps = {
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  disabled?: boolean;
  contentStatus?: string | null;
  contentWordCount?: number | null;
};

/**
 * Known paywall/difficult sites where reader mode typically fails
 */
const KNOWN_PAYWALL_DOMAINS = [
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "economist.com",
  "bloomberg.com",
  "washingtonpost.com",
  "newyorker.com",
  "theathletic.com",
  "foreignpolicy.com",
];

/**
 * Check if URL is from a known paywall site
 */
function isKnownPaywall(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return KNOWN_PAYWALL_DOMAINS.some((domain) => hostname.includes(domain));
  } catch {
    return false;
  }
}

/**
 * Determines if reader content is available and usable
 * Hides button for paywalled, blocked, or minimal content articles
 */
function shouldShowReaderButton(
  articleUrl: string,
  contentStatus: string | null | undefined,
  contentWordCount: number | null | undefined,
): boolean {
  // Hide button for known paywall sites (don't even try)
  if (isKnownPaywall(articleUrl)) {
    return false;
  }

  // If we haven't tried fetching yet, show the button
  if (!contentStatus) return true;

  // Hide button for known failure states
  if (["paywall", "blocked", "timeout", "error"].includes(contentStatus)) {
    return false;
  }

  // Hide button if content is too short (< 100 words)
  // This catches cases like Financial Times where we get minimal HTML
  if (
    contentStatus === "success" &&
    contentWordCount &&
    contentWordCount < 100
  ) {
    return false;
  }

  return true;
}

export default function ReadNowButton({
  articleId,
  articleTitle,
  articleUrl,
  disabled = false,
  contentStatus,
  contentWordCount,
}: ReadNowButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Don't render the button if content is unavailable
  if (!shouldShowReaderButton(articleUrl, contentStatus, contentWordCount)) {
    return null;
  }

  const handleClick = () => {
    // Open drawer immediately so loading state is visible while content fetches
    setIsOpen(true);
  };

  return (
    <>
      <button
        onClick={handleClick}
        disabled={disabled}
        className="text-[11px] sm:text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:text-zinc-400 disabled:cursor-not-allowed transition-colors"
        aria-label="Preview article in reader view"
      >
        Preview article
      </button>

      <ReaderView
        articleId={articleId}
        articleTitle={articleTitle}
        articleUrl={articleUrl}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}
