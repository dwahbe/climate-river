"use client";

import { Eye, EyeOff } from "lucide-react";

type PreviewButtonProps = {
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  contentStatus?: string | null;
  contentWordCount?: number | null;
  onPreview?: (articleId: number, title: string, url: string) => void;
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
 */
function shouldShowButton(
  articleUrl: string,
  contentStatus: string | null | undefined,
  contentWordCount: number | null | undefined,
): boolean {
  if (isKnownPaywall(articleUrl)) {
    return false;
  }

  if (!contentStatus) return true;

  if (["paywall", "blocked", "timeout", "error"].includes(contentStatus)) {
    return false;
  }

  if (
    contentStatus === "success" &&
    contentWordCount &&
    contentWordCount < 100
  ) {
    return false;
  }

  return true;
}

export default function PreviewButton({
  articleId,
  articleTitle,
  articleUrl,
  contentStatus,
  contentWordCount,
  onPreview,
}: PreviewButtonProps) {
  const isAvailable = shouldShowButton(
    articleUrl,
    contentStatus,
    contentWordCount,
  );

  const handleClick = () => {
    if (!isAvailable || !onPreview) return;
    onPreview(articleId, articleTitle, articleUrl);
  };

  if (!isAvailable) {
    return (
      <span
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 cursor-not-allowed"
        title="Article preview not available"
      >
        <EyeOff className="w-4 h-4" />
        <span>Preview</span>
      </span>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-full transition-colors"
      aria-label="Preview article"
    >
      <Eye className="w-4 h-4" />
      <span>Preview</span>
    </button>
  );
}
