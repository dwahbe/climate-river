"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Drawer } from "vaul";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

type ReaderViewProps = {
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  isOpen: boolean;
  onClose: () => void;
  mode?: "mobile" | "tablet";
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
};

type ReaderData = {
  content: string;
  title: string;
  author?: string;
  wordCount: number;
  publishedAt?: string;
  image?: string;
};

export default function ReaderView({
  articleId,
  articleTitle,
  articleUrl,
  isOpen,
  onClose,
  mode = "mobile",
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: ReaderViewProps) {
  const [data, setData] = useState<ReaderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isTablet = mode === "tablet";

  // Calculate read time (roughly 200 words per minute)
  const readTimeMinutes = data?.wordCount
    ? Math.ceil(data.wordCount / 200)
    : null;

  useEffect(() => {
    if (!isOpen) return;

    const fetchContent = async () => {
      setLoading(true);
      setError(null);
      setData(null);

      try {
        const res = await fetch(`/api/reader/${articleId}`);
        const json = await res.json();

        if (!res.ok) {
          if (json.status === "paywall") {
            setError("This article requires a subscription");
          } else if (json.status === "blocked") {
            setError("Publisher blocked reader mode");
          } else if (json.status === "timeout") {
            setError("Article took too long to load");
          } else {
            setError("Could not load article");
          }
          return;
        }

        setData(json.data);
      } catch (err) {
        setError("Failed to fetch article");
        console.error("Reader view error:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchContent();
  }, [isOpen, articleId]);

  const handleClose = () => {
    onClose();
    // Reset state when closing
    setTimeout(() => {
      setData(null);
      setError(null);
    }, 300);
  };

  // Shared content component
  const ReaderContent = () => (
    <>
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900"></div>
        </div>
      )}

      {error && (
        <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-6 text-center">
          <p className="text-zinc-700 mb-3">{error}</p>
          <a
            href={articleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block px-4 py-2 bg-zinc-900 text-white text-sm rounded-md hover:bg-zinc-800 transition"
          >
            Read on original site
          </a>
        </div>
      )}

      {data && !error && (
        <>
          {data.image && (
            <figure className="mb-6">
              <Image
                src={data.image}
                alt=""
                width={800}
                height={400}
                className="w-full rounded-lg object-cover max-h-80"
                unoptimized
              />
            </figure>
          )}
          <article
            className="prose prose-zinc prose-reader max-w-none"
            dangerouslySetInnerHTML={{ __html: data.content }}
          />
        </>
      )}
    </>
  );

  // Tablet: right side panel
  if (isTablet) {
    if (!isOpen) return null;

    return (
      <div className="fixed inset-0 z-50">
        <div
          className="absolute inset-0 bg-black/40 animate-[fadeIn_150ms_ease-out]"
          onClick={handleClose}
          aria-hidden="true"
        />
        <div className="absolute right-0 top-0 bottom-0 w-[85%] max-w-xl pointer-events-none animate-[slideInRight_200ms_ease-out]">
          <div className="bg-white shadow-2xl h-full flex flex-col overflow-hidden pointer-events-auto rounded-l-2xl">
            {/* Header */}
            <div className="p-5 border-b border-zinc-200 bg-zinc-50/50">
              <div className="flex items-start justify-between gap-3 mb-2">
                <h2 className="text-lg font-semibold text-zinc-900 line-clamp-2 flex-1 min-w-0">
                  {data?.title || articleTitle}
                </h2>
                <div className="flex items-center gap-1 flex-shrink-0 -mt-1 -mr-2">
                  <button
                    onClick={onPrev}
                    disabled={!hasPrev}
                    className="p-2 hover:bg-zinc-100 rounded-md transition disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Previous article"
                  >
                    <ChevronLeft className="w-5 h-5 text-zinc-600" />
                  </button>
                  <button
                    onClick={onNext}
                    disabled={!hasNext}
                    className="p-2 hover:bg-zinc-100 rounded-md transition disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Next article"
                  >
                    <ChevronRight className="w-5 h-5 text-zinc-600" />
                  </button>
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-zinc-100 rounded-md transition"
                    aria-label="Close reader view"
                  >
                    <X className="w-5 h-5 text-zinc-600" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                {data?.author && <span>{data.author}</span>}
                {data?.author && <span className="text-zinc-400">•</span>}
                {readTimeMinutes && <span>{readTimeMinutes} min read</span>}
                {readTimeMinutes && <span className="text-zinc-400">•</span>}
                <a
                  href={articleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-zinc-700 hover:text-zinc-900"
                >
                  Read on original site →
                </a>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-6">
              <ReaderContent />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Mobile: bottom drawer
  return (
    <Drawer.Root open={isOpen} onOpenChange={handleClose} direction="bottom">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Drawer.Content className="bg-white flex flex-col rounded-t-[10px] h-[90%] mt-24 fixed bottom-0 left-0 right-0 z-50 overflow-hidden">
          <div className="h-full w-full flex flex-col relative">
            {/* Mobile drag handle */}
            <div className="mx-auto w-12 h-1.5 flex-shrink-0 rounded-full bg-zinc-300 mt-4 mb-4 relative z-10" />

            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-4 pb-4 -mt-2 border-b border-zinc-200 bg-zinc-50/50">
              <div className="flex-1 min-w-0">
                <Drawer.Title className="text-lg font-semibold text-zinc-900 mb-2 line-clamp-2">
                  {data?.title || articleTitle}
                </Drawer.Title>
                <Drawer.Description className="flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                  {data?.author && <span>{data.author}</span>}
                  {data?.author && <span className="text-zinc-400">•</span>}
                  {readTimeMinutes && <span>{readTimeMinutes} min read</span>}
                  {readTimeMinutes && <span className="text-zinc-400">•</span>}
                  <a
                    href={articleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline text-zinc-700 hover:text-zinc-900"
                  >
                    Read on original site →
                  </a>
                </Drawer.Description>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 -mt-1 -mr-1">
                <button
                  onClick={onPrev}
                  disabled={!hasPrev}
                  className="p-2 hover:bg-zinc-100 rounded-md transition disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Previous article"
                >
                  <ChevronLeft className="w-5 h-5 text-zinc-600" />
                </button>
                <button
                  onClick={onNext}
                  disabled={!hasNext}
                  className="p-2 hover:bg-zinc-100 rounded-md transition disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Next article"
                >
                  <ChevronRight className="w-5 h-5 text-zinc-600" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-4 py-6">
              <ReaderContent />
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
