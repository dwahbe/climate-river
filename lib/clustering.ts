// lib/clustering.ts
// Shared clustering constants and utilities used by ingest, discover, maintenance, and split scripts.

import { embed } from "ai";
import { openai } from "@ai-sdk/openai";

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
    const mergedEmbeddings = mergedIndices.map((idx) => articles[idx].embedding);
    const mergedCentroid = computeCentroid(mergedEmbeddings);

    clusters[bestI] = mergedIndices;
    centroids[bestI] = mergedCentroid;

    clusters.splice(bestJ, 1);
    centroids.splice(bestJ, 1);
  }

  return clusters;
}
