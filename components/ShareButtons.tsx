"use client";

import { useState, useCallback } from "react";
import { Share2, Link2, Check } from "lucide-react";

type ShareButtonsProps = {
  url: string;
  title: string;
};

export default function ShareButtons({ url, title }: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = url;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [url]);

  const handleShare = useCallback(async () => {
    // Use Web Share API if available
    if (navigator.share) {
      try {
        await navigator.share({
          title,
          url,
        });
      } catch {
        // User cancelled - do nothing
      }
    } else {
      // Fallback: open Twitter share
      const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`;
      window.open(
        shareUrl,
        "_blank",
        "noopener,noreferrer,width=550,height=420",
      );
    }
  }, [url, title]);

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleShare}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-full transition-colors"
        aria-label="Share article"
      >
        <Share2 className="w-4 h-4" />
        <span className="hidden sm:inline">Share</span>
      </button>
      <button
        onClick={copyToClipboard}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-full transition-colors"
        aria-label={copied ? "Link copied" : "Copy link"}
      >
        {copied ? (
          <>
            <Check className="w-4 h-4 text-emerald-500" />
            <span className="hidden sm:inline text-emerald-600">Copied</span>
          </>
        ) : (
          <>
            <Link2 className="w-4 h-4" />
            <span className="hidden sm:inline">Copy link</span>
          </>
        )}
      </button>
    </div>
  );
}
