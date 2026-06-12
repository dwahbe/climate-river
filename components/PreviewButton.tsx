"use client";

import { Eye, EyeOff } from "lucide-react";
import { isReaderAvailable } from "@/lib/readerAvailability";

type PreviewButtonProps = {
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  contentStatus?: string | null;
  contentWordCount?: number | null;
  onPreview?: (articleId: number, title: string, url: string) => void;
};

export default function PreviewButton({
  articleId,
  articleTitle,
  articleUrl,
  contentStatus,
  contentWordCount,
  onPreview,
}: PreviewButtonProps) {
  // Without a handler (e.g. category pages) the button would be a no-op
  if (!onPreview) return null;

  const isAvailable = isReaderAvailable(
    articleUrl,
    contentStatus,
    contentWordCount,
  );

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
      onClick={() => onPreview(articleId, articleTitle, articleUrl)}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-full transition-colors"
      aria-label="Preview article"
    >
      <Eye className="w-4 h-4" />
      <span>Preview</span>
    </button>
  );
}
