// lib/articleDedupe.ts
// One definition of "we already have this article", shared by the ingest and
// discover paths so the dedup rule can't drift between them (it previously
// existed as three slightly different inline queries).

import { query } from "@/lib/db";

export const DUP_TITLE_WINDOW_DAYS = 7;

/**
 * Returns the existing article id when the URL is already stored, or when the
 * same title (case-insensitive) was fetched within DUP_TITLE_WINDOW_DAYS.
 * Feeds keep items in their window for days — without the title check, every
 * ingest run re-processes the whole feed window.
 */
export async function findRecentDuplicate(opts: {
  title: string;
  url?: string;
}): Promise<number | null> {
  const { title, url } = opts;
  const { rows } = url
    ? await query<{ id: number }>(
        `SELECT id FROM articles
         WHERE canonical_url = $1
            OR (lower(title) = lower($2)
                AND fetched_at >= now() - make_interval(days => ${DUP_TITLE_WINDOW_DAYS}))
         LIMIT 1`,
        [url, title],
      )
    : await query<{ id: number }>(
        `SELECT id FROM articles
         WHERE lower(title) = lower($1)
           AND fetched_at >= now() - make_interval(days => ${DUP_TITLE_WINDOW_DAYS})
         LIMIT 1`,
        [title],
      );
  return rows[0]?.id ?? null;
}
