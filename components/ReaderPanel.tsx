"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { X } from "lucide-react";

type ReaderPanelProps = {
  articleId: number | null;
  articleTitle: string;
  articleUrl: string;
  onClose: () => void;
};

type ReaderData = {
  content: string;
  title: string;
  author?: string;
  wordCount: number;
  publishedAt?: string;
  image?: string;
};

export default function ReaderPanel({
  articleId,
  articleTitle,
  articleUrl,
  onClose,
}: ReaderPanelProps) {
  const [data, setData] = useState<ReaderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calculate read time (roughly 200 words per minute)
  const readTimeMinutes = data?.wordCount
    ? Math.ceil(data.wordCount / 200)
    : null;

  useEffect(() => {
    if (!articleId) {
      setData(null);
      setError(null);
      return;
    }

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
        console.error("Reader panel error:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchContent();
  }, [articleId]);

  if (!articleId) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-400 p-8 text-center">
        <p>Select an article to preview</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-5 border-b border-zinc-200 bg-zinc-50/50">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-lg font-semibold text-zinc-900">
            {data?.title || articleTitle}
          </h2>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-2 hover:bg-zinc-100 rounded-md transition -mt-1 -mr-2"
            aria-label="Close reader view"
          >
            <X className="w-5 h-5 text-zinc-600" />
          </button>
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
              className="prose prose-zinc prose-lg max-w-none"
              dangerouslySetInnerHTML={{ __html: data.content }}
            />
          </>
        )}
      </div>
    </div>
  );
}
