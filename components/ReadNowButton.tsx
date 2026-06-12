"use client";

import { useState } from "react";
import ReaderView from "./ReaderView";
import { isReaderAvailable } from "@/lib/readerAvailability";

type ReadNowButtonProps = {
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  articleSummary?: string | null;
  contentStatus?: string | null;
  contentWordCount?: number | null;
};

export default function ReadNowButton({
  articleId,
  articleTitle,
  articleUrl,
  articleSummary,
  contentStatus,
  contentWordCount,
}: ReadNowButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Don't render the button if content is unavailable
  if (!isReaderAvailable(articleUrl, contentStatus, contentWordCount)) {
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
        className="text-[11px] sm:text-xs font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
        aria-label="Preview article in reader view"
      >
        Preview article
      </button>

      <ReaderView
        articleId={articleId}
        articleTitle={articleTitle}
        articleUrl={articleUrl}
        articleSummary={articleSummary}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}
