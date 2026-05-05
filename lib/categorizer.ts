// lib/categorizer.ts
// Semantic category classification using vector embeddings

import { query } from "./db";
import {
  CATEGORIES,
  categorizeArticle,
  isClimateRelevant,
  normalizeArticleForCategorization,
  type CategoryScore,
  type CategorySlug,
} from "./tagger";
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";

// In-memory cache for category embeddings (survives within a warm instance)
const categoryEmbeddingsCache = new Map<string, number[]>();

/**
 * Get or generate category embedding with multi-tier caching:
 * 1. In-memory Map (warm instance)
 * 2. Database categories.embedding column (persists across cold starts)
 * 3. Generate via OpenAI and store in both tiers
 */
async function getCategoryEmbedding(
  categorySlug: CategorySlug,
): Promise<number[] | null> {
  // Tier 1: in-memory cache
  if (categoryEmbeddingsCache.has(categorySlug)) {
    return categoryEmbeddingsCache.get(categorySlug) || null;
  }

  // Tier 2: check database
  try {
    const stored = await query<{ embedding: string }>(
      `SELECT embedding FROM categories WHERE slug = $1 AND embedding IS NOT NULL`,
      [categorySlug],
    );
    if (stored.rows.length > 0 && stored.rows[0].embedding) {
      const parsed = JSON.parse(stored.rows[0].embedding);
      if (Array.isArray(parsed) && parsed.length > 0) {
        categoryEmbeddingsCache.set(categorySlug, parsed);
        return parsed;
      }
    }
  } catch {
    // DB read failed — fall through to generate
  }

  // Tier 3: generate via OpenAI and persist
  const category = CATEGORIES.find((c) => c.slug === categorySlug);
  if (!category) return null;

  try {
    const representativeText = [
      category.name,
      category.description,
      ...category.keywords.slice(0, 10),
    ].join(" ");

    const { embedding } = await embed({
      model: openai.embeddingModel("text-embedding-3-small"),
      value: representativeText,
    });

    // Store in memory
    categoryEmbeddingsCache.set(categorySlug, embedding);

    // Persist to DB for next cold start
    try {
      await query(`UPDATE categories SET embedding = $2 WHERE slug = $1`, [
        categorySlug,
        JSON.stringify(embedding),
      ]);
    } catch {
      // DB write failed — embedding still works from memory this invocation
    }

    return embedding;
  } catch (error) {
    console.error(
      `Error generating embedding for category ${categorySlug}:`,
      error,
    );
    return null;
  }
}

/**
 * Generate embedding for article content
 */
async function generateArticleEmbedding(
  title: string,
  summary?: string,
): Promise<number[] | null> {
  try {
    const text = [title, summary].filter(Boolean).join(" ").slice(0, 1200);

    const { embedding } = await embed({
      model: openai.embeddingModel("text-embedding-3-small"),
      value: text,
    });

    return embedding;
  } catch (error) {
    console.error("Error generating article embedding:", error);
    return null;
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Internal type for tracking both rule and combined confidence during hybrid scoring
interface HybridScoreInternal extends CategoryScore {
  ruleConfidence: number;
  semanticConfidence: number;
  confidenceSource: "rule" | "semantic" | "hybrid";
}

export type HybridScoreForRanking = CategoryScore & {
  ruleConfidence: number;
};

export function rankHybridCategoryScores<T extends HybridScoreForRanking>(
  scores: T[],
): T[] {
  return [...scores].sort((a, b) => {
    const aStrong = a.ruleConfidence >= 0.7;
    const bStrong = b.ruleConfidence >= 0.7;

    // Strong rule signal wins over weak
    if (aStrong && !bStrong) return -1;
    if (bStrong && !aStrong) return 1;

    // Both strong: higher rule confidence wins primary, then semantic support.
    if (aStrong && bStrong) {
      return b.ruleConfidence - a.ruleConfidence || b.confidence - a.confidence;
    }

    const aHasRuleSignal = a.ruleConfidence >= 0.4;
    const bHasRuleSignal = b.ruleConfidence >= 0.4;

    // A concrete rule match should outrank a semantic-only guess for primary.
    if (aHasRuleSignal && !bHasRuleSignal) return -1;
    if (bHasRuleSignal && !aHasRuleSignal) return 1;

    // Neither strong: use combined confidence
    return b.confidence - a.confidence || b.ruleConfidence - a.ruleConfidence;
  });
}

const SEMANTIC_ONLY_STORAGE_CONFIDENCE = 0.65;
const SEMANTIC_ONLY_PRIMARY_CONFIDENCE = 0.7;
const SEMANTIC_ONLY_PRIMARY_MARGIN = 0.12;
const RULE_PRIMARY_CONFIDENCE = 0.35;

function ruleConfidenceFor(score: CategoryScore): number {
  return score.ruleConfidence ?? 0;
}

function isSemanticOnly(score: CategoryScore): boolean {
  return ruleConfidenceFor(score) === 0 && (score.semanticConfidence ?? 0) > 0;
}

export function filterStorableCategoryScores(
  scores: CategoryScore[],
  minConfidence: number = 0.25,
): CategoryScore[] {
  const storable = scores.filter((score) => {
    if (score.confidence < minConfidence) {
      return false;
    }

    if (!isSemanticOnly(score)) {
      return true;
    }

    return score.confidence >= SEMANTIC_ONLY_STORAGE_CONFIDENCE;
  });

  const sorted = rankHybridCategoryScores(
    storable.map((score) => ({
      ...score,
      ruleConfidence: ruleConfidenceFor(score),
    })),
  );

  const primary = sorted[0];
  if (!primary) {
    return [];
  }

  if (isSemanticOnly(primary)) {
    const nextConfidence = sorted[1]?.confidence ?? 0;
    const margin = primary.confidence - nextConfidence;

    if (
      primary.confidence < SEMANTIC_ONLY_PRIMARY_CONFIDENCE ||
      margin < SEMANTIC_ONLY_PRIMARY_MARGIN
    ) {
      return sorted.filter((score) => !isSemanticOnly(score));
    }
  }

  if (
    !isSemanticOnly(primary) &&
    primary.confidence < RULE_PRIMARY_CONFIDENCE
  ) {
    return [];
  }

  return sorted;
}

/**
 * Enhanced categorization using both rule-based and semantic approaches
 * Returns empty array for non-climate articles.
 *
 * Uses adaptive weighting: when rule-based confidence is high (>=0.7),
 * we trust it more (70% rule, 30% semantic). Otherwise, semantic gets
 * more weight (40% rule, 60% semantic).
 *
 * Primary category selection prioritizes strong rule-based signals to
 * ensure articles with clear keyword matches (like disaster headlines)
 * aren't overridden by semantic similarity to other categories.
 *
 * When articleId is provided, reuses the stored embedding from the DB
 * instead of making a redundant OpenAI API call.
 */
export async function categorizeArticleHybrid(
  title: string,
  summary?: string,
  articleId?: number,
): Promise<CategoryScore[]> {
  const normalized = normalizeArticleForCategorization({ title, summary });

  if (!isClimateRelevant(normalized)) {
    return [];
  }
  // Start with rule-based categorization
  const ruleBasedScores = categorizeArticle(normalized);

  // Try to reuse stored embedding from DB before generating a new one
  let articleEmbedding: number[] | null = null;

  if (articleId) {
    try {
      const stored = await query<{ embedding: string }>(
        `SELECT embedding FROM articles WHERE id = $1 AND embedding IS NOT NULL`,
        [articleId],
      );
      if (stored.rows.length > 0 && stored.rows[0].embedding) {
        // pgvector returns vectors as "[0.1,0.2,...]" — valid JSON
        const parsed = JSON.parse(stored.rows[0].embedding);
        if (Array.isArray(parsed) && parsed.length > 0) {
          articleEmbedding = parsed;
        }
      }
    } catch {
      // Parse failure or DB error — fall through to generate
    }
  }

  // Fall back to generating a new embedding only if none stored
  if (!articleEmbedding) {
    console.log(
      `  ⚡ Generating new embedding for article ${articleId ?? "?"}: "${normalized.title.slice(0, 50)}..."`,
    );
    articleEmbedding = await generateArticleEmbedding(
      normalized.title,
      normalized.summary ?? undefined,
    );
  }

  if (!articleEmbedding) {
    // Fallback to rule-based only if no embedding available at all
    console.warn(
      `No embedding available for "${normalized.title}", using rule-based only`,
    );
    return filterStorableCategoryScores(
      ruleBasedScores.map((score) => ({
        ...score,
        ruleConfidence: score.confidence,
        semanticConfidence: 0,
        confidenceSource: "rule",
      })),
    );
  }

  const hybridScores: HybridScoreInternal[] = [];

  // Process each category
  for (const category of CATEGORIES) {
    const ruleScore = ruleBasedScores.find((s) => s.slug === category.slug);
    const ruleConfidence = ruleScore?.confidence || 0;

    // Get semantic similarity
    const categoryEmbedding = await getCategoryEmbedding(category.slug);
    let semanticConfidence = 0;
    let hasSemanticScore = false;

    if (categoryEmbedding) {
      const similarity = cosineSimilarity(articleEmbedding, categoryEmbedding);
      // Scale similarity to confidence with gradual scaling
      // Maps 0.25-0.85 similarity to 0.0-1.0 confidence (embeddings cluster around 0.4-0.6)
      semanticConfidence = Math.max(
        0,
        Math.min(1.0, (similarity - 0.25) / 0.6),
      );
      hasSemanticScore = true;
    }

    // ADAPTIVE WEIGHTING: Trust strong rule-based signals more
    // When rule confidence is high (>=0.7), it indicates clear keyword/pattern matches
    // that shouldn't be overridden by semantic similarity
    let combinedConfidence: number;
    if (!hasSemanticScore) {
      combinedConfidence = ruleConfidence;
    } else if (ruleConfidence >= 0.7) {
      // Strong rule signal: 70% rule, 30% semantic
      combinedConfidence = ruleConfidence * 0.7 + semanticConfidence * 0.3;
    } else {
      // Weak/no rule signal: 40% rule, 60% semantic (let semantic guide)
      combinedConfidence = ruleConfidence * 0.4 + semanticConfidence * 0.6;
    }

    const confidenceSource =
      ruleConfidence > 0 && hasSemanticScore
        ? "hybrid"
        : ruleConfidence > 0
          ? "rule"
          : "semantic";

    const reasons = [
      ...(ruleScore?.reasons || []),
      categoryEmbedding
        ? `Semantic similarity: ${semanticConfidence.toFixed(3)}`
        : "No semantic score",
    ];

    hybridScores.push({
      slug: category.slug,
      confidence: Math.min(1.0, combinedConfidence),
      ruleConfidence,
      semanticConfidence,
      confidenceSource,
      reasons,
    });
  }

  // SMART PRIMARY SELECTION: Sort with rule-based priority
  // This ensures articles with strong keyword signals (like disaster headlines)
  // get the correct primary category even if semantic scores favor another category
  const sorted = filterStorableCategoryScores(
    rankHybridCategoryScores(hybridScores),
  );

  return sorted.map(
    (item): CategoryScore => ({
      slug: item.slug,
      confidence: item.confidence,
      reasons: item.reasons,
      ruleConfidence: item.ruleConfidence,
      semanticConfidence: item.semanticConfidence,
      confidenceSource: item.confidenceSource,
    }),
  );
}

/**
 * Store article categories in database
 */
export async function storeArticleCategories(
  articleId: number,
  scores: CategoryScore[],
  minConfidence: number = 0.25,
): Promise<void> {
  try {
    // Filter scores by minimum confidence
    const validScores = filterStorableCategoryScores(scores, minConfidence);

    // Clear existing categories for this article before inserting new labels.
    // Recategorization must be able to remove stale or newly non-climate rows.
    await query("DELETE FROM article_categories WHERE article_id = $1", [
      articleId,
    ]);

    if (validScores.length === 0) {
      console.log(
        `No categories with sufficient confidence for article ${articleId}`,
      );
      return;
    }

    // Find primary category (highest confidence)
    const primaryCategory = validScores[0];

    // Insert new categories
    for (const score of validScores) {
      await insertArticleCategory(
        articleId,
        score,
        score.slug === primaryCategory.slug,
      );
    }

    console.log(
      `Stored ${validScores.length} categories for article ${articleId}, primary: ${primaryCategory.slug}`,
    );
  } catch (error) {
    console.error(`Error storing categories for article ${articleId}:`, error);
    throw error;
  }
}

let supportsCategoryMetadata = true;

async function insertArticleCategory(
  articleId: number,
  score: CategoryScore,
  isPrimary: boolean,
): Promise<void> {
  const params = [
    articleId,
    score.confidence,
    isPrimary,
    score.slug,
    score.ruleConfidence ?? null,
    score.semanticConfidence ?? null,
    score.confidenceSource ?? null,
    JSON.stringify(score.reasons),
  ];

  if (supportsCategoryMetadata) {
    try {
      await query(
        `
        INSERT INTO article_categories (
          article_id,
          category_id,
          confidence,
          is_primary,
          rule_confidence,
          semantic_confidence,
          confidence_source,
          reasons
        )
        SELECT $1, c.id, $2, $3, $5, $6, $7, $8::jsonb
        FROM categories c
        WHERE c.slug = $4
      `,
        params,
      );
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        /column .* does not exist|42703/i.test(error.message)
      ) {
        supportsCategoryMetadata = false;
      } else {
        throw error;
      }
    }
  }

  await query(
    `
    INSERT INTO article_categories (article_id, category_id, confidence, is_primary)
    SELECT $1, c.id, $2, $3
    FROM categories c
    WHERE c.slug = $4
  `,
    params.slice(0, 4),
  );
}

/**
 * Categorize and store an article's categories
 */
export async function categorizeAndStoreArticle(
  articleId: number,
  title: string,
  summary?: string,
): Promise<void> {
  try {
    const scores = await categorizeArticleHybrid(title, summary, articleId);
    await storeArticleCategories(articleId, scores);
  } catch (error) {
    console.error(`Error categorizing article ${articleId}:`, error);
    throw error;
  }
}
