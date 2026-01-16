"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles, ChevronDown } from "lucide-react";
import LocalTime from "@/components/LocalTime";
import PublisherLink from "@/components/PublisherLink";
import ShareButtons from "@/components/ShareButtons";
import PublisherIcon from "@/components/PublisherIcon";
import ArticleImage from "@/components/ArticleImage";
import PreviewButton from "@/components/PreviewButton";
import type { Cluster } from "@/lib/models/cluster";

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type FeedCardProps = {
  cluster: Cluster;
  onPreview?: (articleId: number, title: string, url: string) => void;
  isSelected?: boolean;
  variant?: "list" | "grid";
};

export default function FeedCard({
  cluster,
  onPreview,
  isSelected,
  variant = "list",
}: FeedCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isGrid = variant === "grid";
  const publisher = cluster.lead_source || hostFrom(cluster.lead_url);
  const publisherDomain = cluster.lead_homepage
    ? hostFrom(cluster.lead_homepage)
    : hostFrom(cluster.lead_url);
  const leadPing = `/api/click?aid=${cluster.lead_article_id}`;
  const hasImage = !!cluster.lead_image;
  const isCluster = cluster.size > 1;
  const relatedCount = cluster.subs_total;

  // Get unique outlet domains from subs for the stacked avatars
  const subDomains = [
    ...new Set(cluster.subs.map((sub) => hostFrom(sub.url)).filter(Boolean)),
  ].slice(0, 3);

  return (
    <article
      className={`bg-white ${isGrid ? "flex h-full flex-col rounded-xl border border-zinc-200/80 shadow-sm" : "border-b border-zinc-200/80"} ${!isGrid && isSelected ? "lg:bg-zinc-50 lg:ring-2 lg:ring-inset lg:ring-zinc-200" : ""}`}
    >
      {/* Header with padding */}
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex gap-3">
          {/* Publisher Icon */}
          <div className="shrink-0 pt-0.5">
            {cluster.lead_homepage ? (
              <PublisherLink href={cluster.lead_homepage} className="block">
                <PublisherIcon domain={publisherDomain} name={publisher} />
              </PublisherLink>
            ) : (
              <PublisherIcon domain={publisherDomain} name={publisher} />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Header: Author, Source, Time */}
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="flex items-center gap-1.5 text-sm text-zinc-600 min-w-0">
                {cluster.lead_homepage ? (
                  <PublisherLink
                    href={cluster.lead_homepage}
                    className="font-medium text-zinc-900 hover:underline shrink-0"
                  >
                    {publisher}
                  </PublisherLink>
                ) : (
                  <span className="font-medium text-zinc-900 shrink-0">
                    {publisher}
                  </span>
                )}
                {cluster.lead_author && (
                  <>
                    <span className="text-zinc-300 shrink-0">·</span>
                    <span className="text-zinc-500 truncate min-w-0">
                      {cluster.lead_author}
                    </span>
                  </>
                )}
                {cluster.lead_was_rewritten && (
                  <span
                    className="inline-flex items-center text-amber-500 shrink-0"
                    title="Rewritten for improved context by Climate River"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                )}
              </div>
              <span className="text-xs text-zinc-400 whitespace-nowrap shrink-0">
                <LocalTime iso={cluster.published_at} />
              </span>
            </div>

            {/* Title */}
            <h2 className="text-[17px] sm:text-lg font-semibold leading-snug text-zinc-900 mb-1.5 text-pretty">
              <a
                href={cluster.lead_url}
                ping={leadPing}
                className="hover:underline decoration-zinc-400 underline-offset-2 transition-colors"
              >
                {cluster.lead_title}
              </a>
            </h2>

            {/* Dek/Description */}
            {cluster.lead_dek && (
              <p className="text-[15px] text-zinc-600 leading-relaxed mb-2 line-clamp-2 text-pretty">
                {cluster.lead_dek}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Image - aligned with content column */}
      {hasImage && (
        <div className="pl-[68px] pr-4 sm:pl-[72px] sm:pr-5 mt-2">
          <ArticleImage
            src={cluster.lead_image!}
            href={cluster.lead_url}
            ping={leadPing}
          />
        </div>
      )}

      {/* Footer - aligned with content column */}
      <div className="pl-[68px] pr-4 pb-4 sm:pl-[72px] sm:pr-5 sm:pb-5">
        {/* Related coverage dropdown */}
        {isCluster && relatedCount > 0 && (
          <div className="mt-3 mb-3">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="inline-flex items-center gap-2 py-2 px-4 bg-zinc-100 hover:bg-zinc-200/80 rounded-full transition-colors"
            >
              {subDomains.length > 0 && (
                <div className="flex -space-x-2" aria-hidden="true">
                  {subDomains.map((domain, i) => (
                    <div key={domain} style={{ zIndex: subDomains.length - i }}>
                      <PublisherIcon domain={domain} name={domain} size={20} />
                    </div>
                  ))}
                </div>
              )}
              <span className="text-sm font-medium text-zinc-700">
                See related coverage
              </span>
              <ChevronDown
                className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>

            {/* Expanded sub-articles */}
            {isExpanded && (
              <div className="mt-3 space-y-2.5">
                {cluster.subs.slice(0, 3).map((sub) => (
                  <div
                    key={sub.article_id}
                    className="pl-3 border-l-2 border-zinc-200"
                  >
                    <div className="text-xs text-zinc-400 mb-0.5">
                      {sub.source || hostFrom(sub.url)}
                      {sub.author && <span> · {sub.author}</span>}
                    </div>
                    <a
                      href={sub.url}
                      ping={`/api/click?aid=${sub.article_id}`}
                      className="text-[15px] leading-snug text-zinc-600 hover:text-zinc-900 hover:underline"
                    >
                      {sub.title}
                    </a>
                  </div>
                ))}
                {relatedCount > 3 && (
                  <Link
                    href={`/river/${cluster.cluster_id}`}
                    className="inline-block text-sm text-zinc-500 hover:text-zinc-700 hover:underline pl-3"
                    prefetch={false}
                  >
                    +{relatedCount - 3} more articles
                  </Link>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer: Preview + Share buttons */}
        <div className="flex items-center gap-2 pt-1">
          <PreviewButton
            articleId={cluster.lead_article_id}
            articleTitle={cluster.lead_title}
            articleUrl={cluster.lead_url}
            contentStatus={cluster.lead_content_status}
            contentWordCount={cluster.lead_content_word_count}
            onPreview={onPreview}
          />
          <ShareButtons url={cluster.lead_url} title={cluster.lead_title} />
        </div>
      </div>
    </article>
  );
}
