"use client";

import { useState } from "react";
import FeedCard from "@/components/FeedCard";
import ReaderPanel from "@/components/ReaderPanel";
import type { Cluster } from "@/lib/models/cluster";

type SelectedArticle = {
  id: number;
  title: string;
  url: string;
} | null;

type TestingFeedProps = {
  clusters: Cluster[];
};

export default function TestingFeed({ clusters }: TestingFeedProps) {
  const [selectedArticle, setSelectedArticle] = useState<SelectedArticle>(null);

  const handlePreview = (articleId: number, title: string, url: string) => {
    setSelectedArticle({ id: articleId, title, url });
  };

  const handleClosePreview = () => {
    setSelectedArticle(null);
  };

  const isOpen = !!selectedArticle;

  return (
    <div className="lg:flex lg:justify-center">
      {/* Feed Column */}
      <div
        className={`w-full sm:px-6 transition-all duration-300 ease-in-out ${
          isOpen ? "lg:w-1/2 lg:pl-6 lg:pr-3" : "max-w-3xl"
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
          isOpen ? "w-1/2 pr-6 pl-3 opacity-100" : "w-0 opacity-0"
        }`}
      >
        <div className="h-full bg-white overflow-hidden">
          {selectedArticle && (
            <ReaderPanel
              articleId={selectedArticle.id}
              articleTitle={selectedArticle.title}
              articleUrl={selectedArticle.url}
              onClose={handleClosePreview}
            />
          )}
        </div>
      </div>
    </div>
  );
}
