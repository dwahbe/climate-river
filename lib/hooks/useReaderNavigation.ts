"use client";

import { useMemo, useState } from "react";
import { isReaderAvailable } from "@/lib/readerAvailability";
import type { Cluster } from "@/lib/models/cluster";

export type SelectedArticle = {
  id: number;
  title: string;
  url: string;
  summary: string | null;
};

/**
 * Selection + prev/next state for the reader overlay, shared by the home
 * and search feeds. Arrow navigation walks only stories the reader can
 * actually show — the same predicate that drives the cards' Preview buttons.
 */
export function useReaderNavigation(clusters: Cluster[]) {
  const [selectedArticle, setSelectedArticle] =
    useState<SelectedArticle | null>(null);
  // Reader stays mounted after close so the sheet/panel can animate out
  const [readerOpen, setReaderOpen] = useState(false);

  const readable = useMemo(
    () =>
      clusters.filter((c) =>
        isReaderAvailable(
          c.lead_url,
          c.lead_content_status,
          c.lead_content_word_count,
        ),
      ),
    [clusters],
  );

  const selectCluster = (cluster: Cluster) => {
    setSelectedArticle({
      id: cluster.lead_article_id,
      title: cluster.lead_title,
      url: cluster.lead_url,
      summary: cluster.lead_dek,
    });
  };

  const handlePreview = (articleId: number, title: string, url: string) => {
    const cluster = clusters.find((c) => c.lead_article_id === articleId);
    if (cluster) {
      selectCluster(cluster);
    } else {
      setSelectedArticle({ id: articleId, title, url, summary: null });
    }
    setReaderOpen(true);
  };

  const currentIndex = selectedArticle
    ? readable.findIndex((c) => c.lead_article_id === selectedArticle.id)
    : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex !== -1 && currentIndex < readable.length - 1;

  const handlePrev = () => {
    if (hasPrev) selectCluster(readable[currentIndex - 1]);
  };

  const handleNext = () => {
    if (hasNext) selectCluster(readable[currentIndex + 1]);
  };

  const closeReader = () => setReaderOpen(false);

  const isSelected = (cluster: Cluster) =>
    readerOpen && selectedArticle?.id === cluster.lead_article_id;

  return {
    selectedArticle,
    readerOpen,
    handlePreview,
    handlePrev,
    handleNext,
    hasPrev,
    hasNext,
    closeReader,
    isSelected,
  };
}
