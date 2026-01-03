import { getRiverData } from "@/lib/services/riverService";
import TestingFeed from "@/components/TestingFeed";
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
    <div className="w-full pt-1 sm:pt-1.5">
      <TestingFeed clusters={clusters} />
    </div>
  );
}
