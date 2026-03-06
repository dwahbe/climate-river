import { searchArticles } from "@/lib/services/searchService";
import { searchResultToCluster } from "@/lib/models/search";
import SearchFeed from "./SearchFeed";

export default async function SearchResults({ query }: { query: string }) {
  const results = await searchArticles(query);

  if (results.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-zinc-500">No results for &ldquo;{query}&rdquo;</p>
        <p className="text-sm text-zinc-400 mt-1">
          Try different keywords or a broader search term
        </p>
      </div>
    );
  }

  const clusters = results.map(searchResultToCluster);

  return (
    <>
      <p className="text-sm text-zinc-500 mb-4">
        {results.length} result{results.length !== 1 ? "s" : ""} for &ldquo;
        {query}&rdquo;
      </p>
      <SearchFeed clusters={clusters} />
    </>
  );
}
