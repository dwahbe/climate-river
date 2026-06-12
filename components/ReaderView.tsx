"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { Drawer } from "vaul";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

type ReaderViewProps = {
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  articleSummary?: string | null;
  isOpen: boolean;
  onClose: () => void;
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

type ReaderContentProps = {
  loading: boolean;
  error: string | null;
  data: ReaderData | null;
  articleUrl: string;
  articleSummary?: string | null;
};

// Side panel from md up, bottom sheet below
function useIsPanel() {
  const [isPanel, setIsPanel] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsPanel(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isPanel;
}

function ReaderContent({
  loading,
  error,
  data,
  articleUrl,
  articleSummary,
}: ReaderContentProps) {
  return (
    <>
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900"></div>
        </div>
      )}

      {error && (
        <div>
          {/* Full text unavailable — fall back to the feed's summary so the
              story can still be triaged from the reader */}
          {articleSummary && (
            <p className="text-zinc-700 leading-relaxed mb-6">
              {articleSummary}
            </p>
          )}
          <div className="bg-zinc-50 border border-zinc-200 rounded-control p-6 text-center">
            <p className="text-zinc-700 mb-3">{error}</p>
            <a
              href={articleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 bg-zinc-900 text-white text-sm rounded-control hover:bg-zinc-800 transition"
            >
              Read on original site
            </a>
          </div>
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
                className="w-full rounded-card object-cover max-h-80"
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
}

export default function ReaderView({
  articleId,
  articleTitle,
  articleUrl,
  articleSummary,
  isOpen,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: ReaderViewProps) {
  const [data, setData] = useState<ReaderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const isPanel = useIsPanel();
  const hasNavigation = Boolean(onPrev || onNext);

  // Calculate read time (roughly 200 words per minute)
  const readTimeMinutes = data?.wordCount
    ? Math.ceil(data.wordCount / 200)
    : null;

  const handleClose = useCallback(() => {
    onClose();
    // Reset state when closing
    setTimeout(() => {
      setData(null);
      setError(null);
    }, 300);
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    // Abort on articleId change so a slow earlier response can't land after
    // a faster later one and show the wrong article's content
    const controller = new AbortController();

    const fetchContent = async () => {
      setLoading(true);
      setError(null);
      setData(null);

      try {
        const res = await fetch(`/api/reader/${articleId}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        if (controller.signal.aborted) return;

        if (!res.ok) {
          if (json.status === "paywall") {
            setError("This article requires a subscription");
          } else if (json.status === "blocked") {
            setError("Reader view isn't available for this article");
          } else if (json.status === "timeout") {
            setError("Article took too long to load");
          } else {
            setError("Could not load article");
          }
          return;
        }

        setData(json.data);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError("Failed to fetch article");
        console.error("Reader view error:", err);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchContent();
    return () => controller.abort();
  }, [isOpen, articleId]);

  // Start each article at the top when navigating prev/next
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [articleId]);

  // Keyboard: Escape closes (panel only — vaul owns it on mobile), arrows navigate
  useEffect(() => {
    if (!isOpen) return;

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      )
        return;

      if (e.key === "Escape" && isPanel) {
        handleClose();
      } else if (e.key === "ArrowLeft" && hasPrev) {
        onPrev?.();
      } else if (e.key === "ArrowRight" && hasNext) {
        onNext?.();
      } else if (e.key === "Tab" && isPanel) {
        // Keep Tab inside the dialog — aria-modal promises an inert background
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !panel.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (active === first || active === panel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, isPanel, hasPrev, hasNext, onPrev, onNext, handleClose]);

  // Lock background scroll while the panel is open (vaul handles the sheet)
  useEffect(() => {
    if (!isOpen || !isPanel) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen, isPanel]);

  useEffect(() => {
    if (!(isOpen && isPanel)) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, [isOpen, isPanel]);

  // md+: right side panel
  if (isPanel) {
    if (!isOpen) return null;

    return (
      <div className="fixed inset-0 z-50">
        <div
          className="absolute inset-0 bg-black/40 animate-[fadeIn_150ms_ease-out]"
          onClick={handleClose}
          aria-hidden="true"
        />
        <div className="absolute right-0 top-0 bottom-0 w-[90%] max-w-2xl pointer-events-none animate-[slideInRight_200ms_ease-out]">
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={data?.title || articleTitle}
            className="bg-white shadow-2xl h-full flex flex-col overflow-hidden pointer-events-auto rounded-l-card focus:outline-none"
          >
            {/* Header */}
            <div className="p-5 border-b border-zinc-200 bg-zinc-50/50">
              <div className="flex items-start justify-between gap-3 mb-2">
                <h2 className="text-lg font-semibold text-zinc-900 line-clamp-2 flex-1 min-w-0">
                  {data?.title || articleTitle}
                </h2>
                <div className="flex items-center gap-1 flex-shrink-0 -mt-1 -mr-2">
                  {hasNavigation && (
                    <>
                      <button
                        onClick={onPrev}
                        disabled={!hasPrev}
                        className="p-2 hover:bg-zinc-100 rounded-control transition disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Previous article"
                      >
                        <ChevronLeft className="w-5 h-5 text-zinc-600" />
                      </button>
                      <button
                        onClick={onNext}
                        disabled={!hasNext}
                        className="p-2 hover:bg-zinc-100 rounded-control transition disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Next article"
                      >
                        <ChevronRight className="w-5 h-5 text-zinc-600" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-zinc-100 rounded-control transition"
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
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-5 py-6 md:px-8"
            >
              <ReaderContent
                loading={loading}
                error={error}
                data={data}
                articleUrl={articleUrl}
                articleSummary={articleSummary}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Below md: bottom drawer
  return (
    <Drawer.Root open={isOpen} onOpenChange={handleClose} direction="bottom">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Drawer.Content className="bg-white flex flex-col rounded-t-card h-[90%] mt-24 fixed bottom-0 left-0 right-0 z-50 overflow-hidden">
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
              {hasNavigation && (
                <div className="flex items-center gap-1 flex-shrink-0 -mt-1 -mr-1">
                  <button
                    onClick={onPrev}
                    disabled={!hasPrev}
                    className="p-2 hover:bg-zinc-100 rounded-control transition disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Previous article"
                  >
                    <ChevronLeft className="w-5 h-5 text-zinc-600" />
                  </button>
                  <button
                    onClick={onNext}
                    disabled={!hasNext}
                    className="p-2 hover:bg-zinc-100 rounded-control transition disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Next article"
                  >
                    <ChevronRight className="w-5 h-5 text-zinc-600" />
                  </button>
                </div>
              )}
            </div>

            {/* Content */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
              <ReaderContent
                loading={loading}
                error={error}
                data={data}
                articleUrl={articleUrl}
                articleSummary={articleSummary}
              />
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
