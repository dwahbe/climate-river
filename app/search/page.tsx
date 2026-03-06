import { Suspense } from "react";
import SearchResults from "./SearchResults";
import SearchResultsSkeleton from "./SearchResultsSkeleton";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  return {
    title: q ? `Search: ${q}` : "Search",
    description: "Search climate news articles from trusted sources.",
    robots: q ? "noindex" : "index",
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const searchQuery = q?.trim() || "";

  return (
    <div className="w-full pt-1 sm:pt-1.5 pb-10">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Search</h1>

      {searchQuery ? (
        <Suspense fallback={<SearchResultsSkeleton />}>
          <SearchResults query={searchQuery} />
        </Suspense>
      ) : (
        <div className="text-center py-16">
          <p className="text-zinc-400">
            Use the search bar above to find climate news articles
          </p>
        </div>
      )}
    </div>
  );
}
