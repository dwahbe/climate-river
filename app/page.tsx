import { getRiverData } from "@/lib/services/riverService";
import { getPublicationLeaderboard } from "@/lib/repositories/leaderboardRepository";
import HomeFeed from "@/components/HomeFeed";
import ItemListStructuredData from "@/components/ItemListStructuredData";
import type { Metadata } from "next";

// Cache for 5 minutes (300 seconds)
export const revalidate = 300;

// Static metadata consumed by Next.js for SEO and social tags:
// https://nextjs.org/docs/app/building-your-application/optimizing/metadata#static-metadata
export const metadata: Metadata = {
  title: "Climate News Today",
  description:
    "Today's top climate news aggregated from 40+ trusted outlets including The Guardian, NYT, Reuters, and Bloomberg. Stories clustered by topic, ranked for credibility, and updated continuously.",
  openGraph: {
    title: "Climate News Today | Climate River",
    description:
      "Today's top climate news from 40+ trusted outlets. Stories clustered by topic, ranked for credibility, updated continuously.",
    url: "https://climateriver.org",
    images: [
      {
        url: "/api/og",
        width: 1200,
        height: 630,
        alt: "Climate River - Today's top climate news headlines",
      },
    ],
  },
  twitter: {
    title: "Climate News Today | Climate River",
    description:
      "Today's top climate news from 40+ trusted outlets. Stories clustered by topic, ranked for credibility, updated continuously.",
    images: ["/api/og"],
  },
  alternates: {
    canonical: "https://climateriver.org",
  },
};

export default async function RiverPage() {
  const [clusters, leaderboard] = await Promise.all([
    getRiverData({ view: "top", limit: 20 }),
    getPublicationLeaderboard(168, 10),
  ]);

  return (
    <>
      <ItemListStructuredData clusters={clusters} />
      <div className="w-full pt-1 sm:pt-1.5 pb-10">
        <HomeFeed clusters={clusters} leaderboard={leaderboard} />
      </div>
    </>
  );
}
