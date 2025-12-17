import { unstable_cache } from "next/cache";
import * as DB from "@/lib/db";

type LastUpdatedRow = { ts: string | Date };

const formatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Los_Angeles",
});

// Cache the timestamp independently from page cache so all pages show the same value
const getLastUpdatedCached = unstable_cache(
  async (): Promise<string | null> => {
    try {
      const latest = await DB.query<LastUpdatedRow>(`
        select coalesce(max(fetched_at), now()) as ts
        from articles
      `);
      const raw = latest.rows[0]?.ts;
      if (!raw) return new Date().toISOString();

      if (raw instanceof Date) {
        return raw.toISOString();
      }
      if (typeof raw === "string") {
        return raw;
      }

      return new Date().toISOString();
    } catch (error) {
      console.error("Failed to get last updated date:", error);
      return null;
    }
  },
  ["last-updated-timestamp"],
  { revalidate: 60 }, // Shared cache, refreshes every 60s
);

export async function getLastUpdatedDate(): Promise<string | null> {
  return getLastUpdatedCached();
}

export default async function LastUpdated() {
  const lastUpdatedISO = await getLastUpdatedDate();

  // If database connection failed, don't render anything
  if (!lastUpdatedISO) {
    return null;
  }

  const pretty = formatter.format(new Date(lastUpdatedISO));

  return (
    <div className="text-xs text-zinc-500">
      Last updated <time dateTime={lastUpdatedISO}>{pretty} PT</time>
    </div>
  );
}
