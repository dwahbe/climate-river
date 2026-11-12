import { buildRssXml, loadFeedClusters } from "@/lib/services/feedService";

export const revalidate = 300; // Regenerate at most every 5 minutes

export async function GET() {
  // No try/catch on purpose. If the query fails this throws, ISR keeps serving
  // the last good feed and retries on the next request. Catching the error and
  // returning an empty feed got that empty feed cached for five minutes.
  const clusters = await loadFeedClusters();

  return new Response(buildRssXml(clusters), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
