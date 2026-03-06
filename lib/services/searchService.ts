import { query } from "@/lib/db";
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import type { SearchResult } from "@/lib/models/search";

const SEARCH_FIELDS = `
  a.id as article_id,
  coalesce(a.rewritten_title, a.title) as title,
  (a.rewritten_title IS NOT NULL) as was_rewritten,
  a.canonical_url as url,
  a.dek,
  coalesce(a.publisher_name, s.name) as source,
  coalesce(a.publisher_homepage, s.homepage_url) as source_homepage,
  a.author,
  a.published_at,
  a.content_image as image,
  a.content_status,
  a.content_word_count
`;

const EXCLUDE_AGGREGATORS = `
  AND a.canonical_url NOT LIKE 'https://news.google.com%'
  AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
  AND a.canonical_url NOT LIKE 'https://www.msn.com%'
`;

async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });
  return embedding;
}

async function keywordSearch(
  q: string,
  limit: number,
): Promise<SearchResult[]> {
  const { rows } = await query<SearchResult>(
    `SELECT ${SEARCH_FIELDS},
       ts_rank_cd(a.search_vector, plainto_tsquery('english', $1)) as score
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.search_vector @@ plainto_tsquery('english', $1)
     ${EXCLUDE_AGGREGATORS}
     ORDER BY ts_rank_cd(a.search_vector, plainto_tsquery('english', $1)) DESC
     LIMIT $2`,
    [q, limit],
  );
  return rows;
}

async function semanticSearch(
  q: string,
  limit: number,
): Promise<SearchResult[]> {
  const embedding = await embedQuery(q);
  const embStr = JSON.stringify(embedding);
  const { rows } = await query<SearchResult>(
    `SELECT ${SEARCH_FIELDS},
       1 - (a.embedding <=> $1::vector) as score
     FROM articles a
     LEFT JOIN sources s ON s.id = a.source_id
     WHERE a.embedding IS NOT NULL
       AND 1 - (a.embedding <=> $1::vector) > 0.3
     ${EXCLUDE_AGGREGATORS}
     ORDER BY a.embedding <=> $1::vector
     LIMIT $2`,
    [embStr, limit],
  );
  return rows;
}

/**
 * Reciprocal Rank Fusion: merges two ranked result sets into one.
 * Score = sum(1 / (k + rank)) across both lists.
 */
function rrfMerge(
  keywordResults: SearchResult[],
  semanticResults: SearchResult[],
  limit: number,
  k = 60,
): SearchResult[] {
  const scores = new Map<number, { result: SearchResult; score: number }>();

  keywordResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank + 1);
    scores.set(result.article_id, { result, score: rrfScore });
  });

  semanticResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(result.article_id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(result.article_id, { result, score: rrfScore });
    }
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
}

export async function searchArticles(
  q: string,
  limit = 20,
): Promise<SearchResult[]> {
  if (!q || q.trim().length < 2) return [];

  const fetchLimit = limit * 2;

  const [keywordResults, semanticResults] = await Promise.allSettled([
    keywordSearch(q, fetchLimit),
    semanticSearch(q, fetchLimit),
  ]);

  const kw = keywordResults.status === "fulfilled" ? keywordResults.value : [];
  const sem =
    semanticResults.status === "fulfilled" ? semanticResults.value : [];

  if (keywordResults.status === "rejected") {
    console.error("Keyword search failed:", keywordResults.reason);
  }
  if (semanticResults.status === "rejected") {
    console.error("Semantic search failed:", semanticResults.reason);
  }

  if (kw.length > 0 && sem.length > 0) {
    return rrfMerge(kw, sem, limit);
  }

  return kw.length > 0 ? kw.slice(0, limit) : sem.slice(0, limit);
}
