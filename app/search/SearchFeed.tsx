"use client";

import { useState } from "react";
import FeedCard from "@/components/FeedCard";
import ReaderView from "@/components/ReaderView";
import type { Cluster } from "@/lib/models/cluster";

type SelectedArticle = {
  id: number;
  title: string;
  url: string;
} | null;

export default function SearchFeed({ clusters }: { clusters: Cluster[] }) {
  const [selectedArticle, setSelectedArticle] = useState<SelectedArticle>(null);
  // Kept mounted after close so the sheet/panel can animate out
  const [readerOpen, setReaderOpen] = useState(false);

  const handlePreview = (articleId: number, title: string, url: string) => {
    setSelectedArticle({ id: articleId, title, url });
    setReaderOpen(true);
  };

  const currentIndex = selectedArticle
    ? clusters.findIndex((c) => c.lead_article_id === selectedArticle.id)
    : -1;

  const handlePrev = () => {
    if (currentIndex > 0) {
      const prev = clusters[currentIndex - 1];
      setSelectedArticle({
        id: prev.lead_article_id,
        title: prev.lead_title,
        url: prev.lead_url,
      });
    }
  };

  const handleNext = () => {
    if (currentIndex < clusters.length - 1) {
      const next = clusters[currentIndex + 1];
      setSelectedArticle({
        id: next.lead_article_id,
        title: next.lead_title,
        url: next.lead_url,
      });
    }
  };

  return (
    <>
      <div className="divide-y divide-zinc-200/80 border-zinc-200/80 -mx-4 border-b sm:mx-0 sm:overflow-hidden sm:rounded-card sm:border">
        {clusters.map((cluster) => (
          <FeedCard
            key={cluster.cluster_id}
            cluster={cluster}
            onPreview={handlePreview}
            isSelected={
              readerOpen && selectedArticle?.id === cluster.lead_article_id
            }
          />
        ))}
      </div>

      {selectedArticle && (
        <ReaderView
          articleId={selectedArticle.id}
          articleTitle={selectedArticle.title}
          articleUrl={selectedArticle.url}
          isOpen={readerOpen}
          onClose={() => setReaderOpen(false)}
          onPrev={handlePrev}
          onNext={handleNext}
          hasPrev={currentIndex > 0}
          hasNext={currentIndex < clusters.length - 1}
        />
      )}
    </>
  );
}
