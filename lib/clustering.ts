// lib/clustering.ts
// Shared clustering constants and utilities used by ingest, discover, maintenance, and split scripts.

import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { query } from "@/lib/db";

export const CLUSTER_CONFIG = {
  /** Cosine similarity threshold for adding articles to clusters */
  SIMILARITY_THRESHOLD: 0.68,
  /** Cosine similarity threshold for merging two clusters */
  MERGE_THRESHOLD: 0.72,
  /** Hard cap on articles per cluster */
  MAX_CLUSTER_SIZE: 25,
  /** How far back to look for cluster candidates */
  LOOKBACK_DAYS: 5,
} as const;

/**
 * Generate an embedding for article text using OpenAI text-embedding-3-small.
 * Returns empty array on failure (callers should handle gracefully).
 */
export async function generateEmbedding(
  title: string,
  description?: string,
): Promise<number[]> {
  try {
    const text = description ? `${title}\n\n${description}` : title;
    const truncatedText = text.substring(0, 8000);
    const { embedding } = await embed({
      model: openai.embeddingModel("text-embedding-3-small"),
      value: truncatedText,
    });
    return embedding;
  } catch (error) {
    console.error("Error generating embedding:", error);
    return [];
  }
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Compute the mean embedding (centroid) for a set of vectors. */
export function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const centroid = new Array<number>(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i] / embeddings.length;
    }
  }
  return centroid;
}

type ArticleForClustering = {
  article_id: number;
  embedding: number[];
};

/**
 * Agglomerative clustering with centroid linkage.
 * Merges closest pair of sub-clusters while similarity > threshold and combined size <= maxSize.
 * Returns array of sub-clusters (each is an array of article indices into the input array).
 */
export function agglomerativeCluster(
  articles: ArticleForClustering[],
  threshold: number,
  maxSize: number,
): number[][] {
  if (articles.length === 0) return [];

  // Initialize: each article in its own cluster
  const clusters: number[][] = articles.map((_, i) => [i]);

  // Precompute centroids
  const centroids: number[][] = articles.map((a) => [...a.embedding]);

  while (clusters.length > 1) {
    let bestSim = -1;
    let bestI = -1,
      bestJ = -1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[i].length + clusters[j].length > maxSize) continue;
        const sim = cosineSimilarity(centroids[i], centroids[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestSim < threshold || bestI === -1) break;

    // Merge bestJ into bestI
    const mergedIndices = [...clusters[bestI], ...clusters[bestJ]];
    const mergedEmbeddings = mergedIndices.map(
      (idx) => articles[idx].embedding,
    );
    const mergedCentroid = computeCentroid(mergedEmbeddings);

    clusters[bestI] = mergedIndices;
    centroids[bestI] = mergedCentroid;

    clusters.splice(bestJ, 1);
    centroids.splice(bestJ, 1);
  }

  return clusters;
}

// ---------- Shared stop-word list for keyword extraction ----------

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "by",
  "from",
  "at",
  "is",
  "are",
  "was",
  "were",
  "be",
  "as",
]);

/**
 * Generate a deterministic cluster key from a title.
 * Normalizes unicode, strips accents/punctuation, removes stop words,
 * and joins the first 8 significant words with hyphens.
 * Returns empty string if no significant words remain.
 */
export function clusterKey(title: string): string {
  const t = (title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !STOP_WORDS.has(w) && w.length >= 3);
  return kept.slice(0, 8).join("-");
}

/**
 * Find the best matching cluster for an article embedding using centroid similarity.
 * Returns null if no cluster exceeds the similarity threshold.
 */
export async function findBestCluster(
  embedding: string,
  opts?: {
    maxSize?: number;
    threshold?: number;
    lookbackDays?: number;
  },
): Promise<{ clusterId: number; similarity: number; size: number } | null> {
  const maxSize = opts?.maxSize ?? CLUSTER_CONFIG.MAX_CLUSTER_SIZE;
  const threshold = opts?.threshold ?? CLUSTER_CONFIG.SIMILARITY_THRESHOLD;
  const lookbackDays = opts?.lookbackDays ?? CLUSTER_CONFIG.LOOKBACK_DAYS;

  const candidates = await query<{
    cluster_id: number;
    similarity: number;
    size: number;
  }>(
    `
    WITH cluster_centroids AS (
      SELECT
        ac.cluster_id,
        COUNT(*)::int AS size,
        AVG(a.embedding) AS centroid
      FROM article_clusters ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.embedding IS NOT NULL
        AND a.fetched_at >= now() - make_interval(days => $4)
      GROUP BY ac.cluster_id
      HAVING COUNT(*) < $2
    )
    SELECT
      cluster_id,
      1 - (centroid <=> $1::vector) AS similarity,
      size
    FROM cluster_centroids
    WHERE 1 - (centroid <=> $1::vector) > $3
    ORDER BY centroid <=> $1::vector
    LIMIT 1
  `,
    [embedding, maxSize, threshold, lookbackDays],
  );

  if (candidates.rows.length === 0) return null;
  const best = candidates.rows[0];
  return {
    clusterId: best.cluster_id,
    similarity: best.similarity,
    size: best.size,
  };
}

/**
 * Update cluster_scores metadata (lead article, size) for a single cluster.
 * Non-throwing — logs errors but doesn't fail the caller.
 */
export async function updateClusterMetadata(clusterId: number): Promise<void> {
  try {
    await query(
      `
      INSERT INTO cluster_scores (cluster_id, lead_article_id, size, score)
      SELECT
        $1 as cluster_id,
        (SELECT a.id
         FROM articles a
         JOIN article_clusters ac ON ac.article_id = a.id
         WHERE ac.cluster_id = $1
         ORDER BY a.published_at DESC, a.id DESC
         LIMIT 1) as lead_article_id,
        (SELECT COUNT(*)
         FROM article_clusters
         WHERE cluster_id = $1) as size,
        0 as score
      ON CONFLICT (cluster_id) DO UPDATE SET
        lead_article_id = EXCLUDED.lead_article_id,
        size = EXCLUDED.size,
        updated_at = NOW()
    `,
      [clusterId],
    );
  } catch (error) {
    console.error(
      `Failed to update cluster metadata for cluster ${clusterId}:`,
      error,
    );
  }
}

type AssignClusterOptions = {
  /** Embedding JSON string. If omitted, fetched from DB. */
  embedding?: string | null;
  /** Skip if article is already in a cluster. Default: true. */
  skipIfClustered?: boolean;
  /** Update cluster_scores metadata after assignment. Default: true. */
  updateMetadata?: boolean;
};

/**
 * Assign an article to its best matching cluster, or create a singleton.
 * Full flow: check existing → resolve embedding → find best cluster → assign or create singleton.
 */
export async function assignArticleToCluster(
  articleId: number,
  title: string,
  opts?: AssignClusterOptions,
): Promise<void> {
  const skipIfClustered = opts?.skipIfClustered ?? true;
  const shouldUpdateMetadata = opts?.updateMetadata ?? true;

  // Skip if already clustered
  if (skipIfClustered) {
    const existing = await query<{ cluster_id: number }>(
      `SELECT cluster_id FROM article_clusters WHERE article_id = $1`,
      [articleId],
    );
    if (existing.rows.length > 0) return;
  }

  // Resolve embedding: use passed value, or fetch from DB
  let articleEmbedding = opts?.embedding ?? null;
  if (!articleEmbedding) {
    const articleResult = await query<{ embedding: string }>(
      `SELECT embedding FROM articles WHERE id = $1 AND embedding IS NOT NULL`,
      [articleId],
    );
    if (articleResult.rows.length === 0) {
      console.log(`Article ${articleId} has no embedding, skipping clustering`);
      return;
    }
    articleEmbedding = articleResult.rows[0].embedding;
  }

  // Find best matching cluster via centroid similarity
  const match = await findBestCluster(articleEmbedding);

  if (match) {
    console.log(
      `Article ${articleId} matched cluster ${match.clusterId} (centroid sim: ${match.similarity.toFixed(3)}, size: ${match.size})`,
    );
    await query(
      `INSERT INTO article_clusters (article_id, cluster_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [articleId, match.clusterId],
    );
    if (shouldUpdateMetadata) await updateClusterMetadata(match.clusterId);
    return;
  }

  // No matching cluster — create singleton
  const key = clusterKey(title) || `semantic-${Date.now()}-${articleId}`;
  const cluster = await query<{ id: number }>(
    `INSERT INTO clusters (key) VALUES ($1)
     ON CONFLICT (key) DO UPDATE SET key = excluded.key RETURNING id`,
    [key],
  );
  const clusterId = cluster.rows[0].id;
  await query(
    `INSERT INTO article_clusters (article_id, cluster_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [articleId, clusterId],
  );
  console.log(
    `Created singleton cluster ${clusterId} for article ${articleId}`,
  );
  if (shouldUpdateMetadata) await updateClusterMetadata(clusterId);
}
