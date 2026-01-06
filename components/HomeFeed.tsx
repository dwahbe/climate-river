"use client";

import { useState, useEffect } from "react";
import FeedCard from "@/components/FeedCard";
import ReaderPanel from "@/components/ReaderPanel";
import ReaderView from "@/components/ReaderView";
import type { Cluster } from "@/lib/models/cluster";

type SelectedArticle = {
  id: number;
  title: string;
  url: string;
} | null;

type HomeFeedProps = {
  clusters: Cluster[];
};

type DeviceType = "mobile" | "tablet" | "desktop";

export default function HomeFeed({ clusters }: HomeFeedProps) {
  const [selectedArticle, setSelectedArticle] = useState<SelectedArticle>(null);
  const [deviceType, setDeviceType] = useState<DeviceType>("desktop");

  useEffect(() => {
    const checkDevice = () => {
      const width = window.innerWidth;
      if (width < 768) {
        setDeviceType("mobile");
      } else if (width < 1024) {
        setDeviceType("tablet");
      } else {
        setDeviceType("desktop");
      }
    };
    checkDevice();
    window.addEventListener("resize", checkDevice);
    return () => window.removeEventListener("resize", checkDevice);
  }, []);

  const handlePreview = (articleId: number, title: string, url: string) => {
    setSelectedArticle({ id: articleId, title, url });
  };

  const handleClosePreview = () => {
    setSelectedArticle(null);
  };

  // Find current index for navigation
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

  const isOpen = !!selectedArticle;

  return (
    <div className="lg:flex lg:justify-center lg:gap-6">
      {/* Feed Column */}
      <div
        className={`w-full max-w-3xl sm:px-6 transition-all duration-300 ease-in-out ${
          isOpen ? "lg:flex-shrink-0" : ""
        }`}
      >
        <h1 className="mb-3 px-4 sm:px-0 text-xl font-semibold tracking-tight">
          Top Stories
        </h1>

        <div className="divide-y divide-zinc-200/80">
          {clusters.map((cluster) => (
            <FeedCard
              key={cluster.cluster_id}
              cluster={cluster}
              onPreview={handlePreview}
              isSelected={selectedArticle?.id === cluster.lead_article_id}
            />
          ))}
        </div>

        {clusters.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-zinc-500">No stories available</p>
          </div>
        )}
      </div>

      {/* Reader Panel - Desktop only */}
      <div
        className={`hidden lg:block sticky top-0 h-screen transition-all duration-300 ease-in-out overflow-hidden ${
          isOpen ? "w-[700px] flex-shrink-0 pr-6 opacity-100" : "w-0 opacity-0"
        }`}
      >
        <div className="h-full bg-white overflow-hidden">
          {selectedArticle && (
            <ReaderPanel
              articleId={selectedArticle.id}
              articleTitle={selectedArticle.title}
              articleUrl={selectedArticle.url}
              onClose={handleClosePreview}
              onPrev={handlePrev}
              onNext={handleNext}
              hasPrev={currentIndex > 0}
              hasNext={currentIndex < clusters.length - 1}
            />
          )}
        </div>
      </div>

      {/* Reader View - Mobile/Tablet */}
      {deviceType !== "desktop" && selectedArticle && (
        <ReaderView
          articleId={selectedArticle.id}
          articleTitle={selectedArticle.title}
          articleUrl={selectedArticle.url}
          isOpen={isOpen}
          onClose={handleClosePreview}
          mode={deviceType}
          onPrev={handlePrev}
          onNext={handleNext}
          hasPrev={currentIndex > 0}
          hasNext={currentIndex < clusters.length - 1}
        />
      )}
    </div>
  );
}
