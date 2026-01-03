import { getRiverData } from "@/lib/services/riverService";
import FeedCard from "@/components/FeedCard";
import type { Metadata } from "next";

// Cache for 5 minutes
export const revalidate = 300;
export const runtime = "nodejs";

// Don't index this testing page
export const metadata: Metadata = {
  title: "Testing - New UI",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function TestingPage() {
  const clusters = await getRiverData({
    view: "top",
    limit: 20,
  });

  return (
    <div className="mx-auto w-full max-w-3xl sm:px-6 pt-1 sm:pt-1.5">
      <h1 className="mb-3 px-4 sm:px-0 text-xl font-semibold tracking-tight">
        Top Stories
      </h1>

      {/* Feed */}
      <div className="divide-y divide-zinc-200/80">
        {clusters.map((cluster) => (
          <FeedCard key={cluster.cluster_id} cluster={cluster} />
        ))}
      </div>

      {/* Empty state */}
      {clusters.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-zinc-500">No stories available</p>
        </div>
      )}
    </div>
  );
}
