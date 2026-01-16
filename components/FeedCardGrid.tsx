import FeedCard from "@/components/FeedCard";
import type { Cluster } from "@/lib/models/cluster";

type FeedCardGridProps = {
  clusters: Cluster[];
  emptyMessage?: string;
  className?: string;
};

export default function FeedCardGrid({
  clusters,
  emptyMessage = "No stories available right now.",
  className = "",
}: FeedCardGridProps) {
  if (clusters.length === 0) {
    return <p className="py-6 text-sm text-zinc-500">{emptyMessage}</p>;
  }

  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${className}`}>
      {clusters.map((cluster) => (
        <FeedCard key={cluster.cluster_id} cluster={cluster} variant="grid" />
      ))}
    </div>
  );
}
