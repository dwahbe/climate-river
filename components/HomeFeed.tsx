"use client";

import { useState } from "react";
import FeedCard from "@/components/FeedCard";
import ReaderView from "@/components/ReaderView";
import PublicationLeaderboard from "@/components/PublicationLeaderboard";
import type { Cluster } from "@/lib/models/cluster";
import type { LeaderboardEntry } from "@/lib/repositories/leaderboardRepository";

type SelectedArticle = {
  id: number;
  title: string;
  url: string;
} | null;

type HomeFeedProps = {
  clusters: Cluster[];
  leaderboard: LeaderboardEntry[];
};

export default function HomeFeed({ clusters, leaderboard }: HomeFeedProps) {
  const [selectedArticle, setSelectedArticle] = useState<SelectedArticle>(null);
  // Kept mounted after close so the sheet/panel can animate out
  const [readerOpen, setReaderOpen] = useState(false);

  const handlePreview = (articleId: number, title: string, url: string) => {
    setSelectedArticle({ id: articleId, title, url });
    setReaderOpen(true);
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

  return (
    <>
      <div className="lg:flex lg:gap-6">
        {/* Feed Column */}
        <div className="mx-auto max-w-3xl sm:px-6 lg:mx-0 lg:px-0 lg:flex-1 lg:min-w-0">
          <h1 className="mb-3 text-xl font-semibold tracking-tight">
            Top Stories
          </h1>

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

          {clusters.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-zinc-500">No stories available</p>
            </div>
          )}
        </div>

        {/* Right Column — Leaderboard */}
        <div className="hidden lg:block shrink-0 lg:w-[300px]">
          <h2 className="mb-3 text-xl font-semibold tracking-tight">
            Weekly Leaderboard
          </h2>
          <PublicationLeaderboard entries={leaderboard} />
          <p className="mt-2 px-1 text-[11px] text-zinc-400">
            Ranked by story impact — how widely each outlet&apos;s scoops are
            covered.{" "}
            <a
              href="/about#how-is-the-weekly-leaderboard-calculated"
              className="underline decoration-zinc-300 hover:decoration-zinc-400"
            >
              Learn more
            </a>
          </p>
        </div>
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
