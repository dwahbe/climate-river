"use client";

import FeedCard from "@/components/FeedCard";
import ReaderView from "@/components/ReaderView";
import PublicationLeaderboard from "@/components/PublicationLeaderboard";
import { useReaderNavigation } from "@/lib/hooks/useReaderNavigation";
import type { Cluster } from "@/lib/models/cluster";
import type { LeaderboardEntry } from "@/lib/repositories/leaderboardRepository";

type HomeFeedProps = {
  clusters: Cluster[];
  leaderboard: LeaderboardEntry[];
};

export default function HomeFeed({ clusters, leaderboard }: HomeFeedProps) {
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
                isSelected={isSelected(cluster)}
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
