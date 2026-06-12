"use client";

import FeedCard from "@/components/FeedCard";
import ReaderView from "@/components/ReaderView";
import { useReaderNavigation } from "@/lib/hooks/useReaderNavigation";
import type { Cluster } from "@/lib/models/cluster";

export default function SearchFeed({ clusters }: { clusters: Cluster[] }) {
  const {
    selectedArticle,
    readerOpen,
    handlePreview,
    handlePrev,
    handleNext,
    hasPrev,
    hasNext,
    closeReader,
    isSelected,
  } = useReaderNavigation(clusters);

  return (
    <>
      <div className="divide-y divide-zinc-200/80 border-zinc-200/80 -mx-4 border-b sm:mx-0 sm:overflow-hidden sm:rounded-card sm:border">
        {clusters.map((cluster) => (
          <FeedCard
            key={cluster.cluster_id}
            cluster={cluster}
            onPreview={handlePreview}
            isSelected={isSelected(cluster)}
          />
        ))}
      </div>

      {selectedArticle && (
        <ReaderView
          articleId={selectedArticle.id}
          articleTitle={selectedArticle.title}
          articleUrl={selectedArticle.url}
          articleSummary={selectedArticle.summary}
          isOpen={readerOpen}
          onClose={closeReader}
          onPrev={handlePrev}
          onNext={handleNext}
          hasPrev={hasPrev}
          hasNext={hasNext}
        />
      )}
    </>
  );
}
