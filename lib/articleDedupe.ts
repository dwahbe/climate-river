// lib/articleDedupe.ts
// One definition of "we already have this article", shared by the ingest,
// discover and discover-web paths so the dedup rule can't drift between them
// (it previously existed as three slightly different inline queries).

import { query } from "@/lib/db";

export const DUP_TITLE_WINDOW_DAYS = 7;

export type DuplicateMatch = {
  id: number;
  reason: "duplicate_url" | "duplicate_title";
};

/**
 * Returns the existing article and which rule matched: the URL is already
 * stored, or the same title (case-insensitive) was fetched within
 * DUP_TITLE_WINDOW_DAYS. A URL match wins when both apply. Feeds keep items in
 * their window for days — without the title check, every ingest run
 * re-processes the whole feed window.
 */
export async function findRecentDuplicateMatch(opts: {
  title: string;
  url?: string;
}): Promise<DuplicateMatch | null> {
  const { title, url } = opts;
  const { rows } = url
    ? await query<{ id: number; by_url: boolean }>(
        `SELECT id, (canonical_url = $1) AS by_url FROM articles
         WHERE canonical_url = $1
            OR (lower(title) = lower($2)
                AND fetched_at >= now() - make_interval(days => ${DUP_TITLE_WINDOW_DAYS}))
         ORDER BY (canonical_url = $1) DESC
         LIMIT 1`,
        [url, title],
      )
    : await query<{ id: number; by_url: boolean }>(
        `SELECT id, false AS by_url FROM articles
         WHERE lower(title) = lower($1)
           AND fetched_at >= now() - make_interval(days => ${DUP_TITLE_WINDOW_DAYS})
         LIMIT 1`,
        [title],
      );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    reason: row.by_url ? "duplicate_url" : "duplicate_title",
  };
}

/** The existing article's id under the same rule, or null. */
export async function findRecentDuplicate(opts: {
  title: string;
  url?: string;
}): Promise<number | null> {
  return (await findRecentDuplicateMatch(opts))?.id ?? null;
}
