"use client";

import { useState, useEffect } from "react";
import FeedCard from "@/components/FeedCard";
import ReaderView from "@/components/ReaderView";
import type { Cluster } from "@/lib/models/cluster";

type SelectedArticle = {
  id: number;
  title: string;
  url: string;
} | null;

type DeviceType = "mobile" | "tablet" | "desktop";

export default function SearchFeed({ clusters }: { clusters: Cluster[] }) {
  const [selectedArticle, setSelectedArticle] = useState<SelectedArticle>(null);
  const [deviceType, setDeviceType] = useState<DeviceType>("desktop");

  useEffect(() => {
    const checkDevice = () => {
      const width = window.innerWidth;
      if (width < 768) setDeviceType("mobile");
      else if (width < 1280) setDeviceType("tablet");
      else setDeviceType("desktop");
    };
    checkDevice();
    window.addEventListener("resize", checkDevice);
    return () => window.removeEventListener("resize", checkDevice);
  }, []);

  const handlePreview = (articleId: number, title: string, url: string) => {
    setSelectedArticle({ id: articleId, title, url });
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
      <div className="divide-y divide-zinc-200/80 -mx-4 sm:mx-0">
        {clusters.map((cluster) => (
          <FeedCard
            key={cluster.cluster_id}
            cluster={cluster}
            onPreview={handlePreview}
            isSelected={selectedArticle?.id === cluster.lead_article_id}
          />
        ))}
      </div>

      {selectedArticle && (
        <ReaderView
          articleId={selectedArticle.id}
          articleTitle={selectedArticle.title}
          articleUrl={selectedArticle.url}
          isOpen={!!selectedArticle}
          onClose={() => setSelectedArticle(null)}
          mode={deviceType === "desktop" ? "tablet" : deviceType}
          onPrev={handlePrev}
          onNext={handleNext}
          hasPrev={currentIndex > 0}
          hasNext={currentIndex < clusters.length - 1}
        />
      )}
    </>
  );
}
