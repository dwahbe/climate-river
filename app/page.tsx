import { getRiverData } from "@/lib/services/riverService";
import RiverClusterList from "@/components/RiverClusterList";

// Cache for 5 minutes (300 seconds)
export const revalidate = 300;
export const runtime = "nodejs";

export default async function RiverPage() {
  const clusters = await getRiverData({
    view: "top",
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 pt-2 sm:pt-2.5">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">
        Top news
      </h1>
      <RiverClusterList clusters={clusters} />
    </div>
  );
}
