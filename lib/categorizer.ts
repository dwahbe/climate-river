// lib/categorizer.ts
// Semantic category classification using vector embeddings

import { query } from './db'
import {
  CATEGORIES,
  categorizeArticle,
  type CategoryScore,
  type CategorySlug,
} from './tagger'
import { embed } from 'ai'
import { openai } from '@ai-sdk/openai'

// Cache for category embeddings to avoid repeated API calls
const categoryEmbeddingsCache = new Map<string, number[]>()

/**
 * Generate embeddings for category representative texts
 * This creates semantic "anchors" for each category
 */
async function getCategoryEmbedding(
  categorySlug: CategorySlug
): Promise<number[] | null> {
  // Check cache first
  if (categoryEmbeddingsCache.has(categorySlug)) {
    return categoryEmbeddingsCache.get(categorySlug) || null
  }

  const category = CATEGORIES.find((c) => c.slug === categorySlug)
  if (!category) return null

  try {
    // Create representative text for the category
    const representativeText = [
      category.name,
      category.description,
      ...category.keywords.slice(0, 10), // Use top keywords
    ].join(' ')

    const { embedding } = await embed({
      model: openai.textEmbeddingModel('text-embedding-3-small'),
      value: representativeText,
    })

    categoryEmbeddingsCache.set(categorySlug, embedding)
    return embedding
  } catch (error) {
    console.error(
      `Error generating embedding for category ${categorySlug}:`,
      error
    )
    return null
  }
}

/**
 * Generate embedding for article content
 */
async function generateArticleEmbedding(
  title: string,
  summary?: string
): Promise<number[] | null> {
  try {
    const text = [title, summary].filter(Boolean).join(' ').slice(0, 1200)

    const { embedding } = await embed({
      model: openai.textEmbeddingModel('text-embedding-3-small'),
      value: text,
    })

    return embedding
  } catch (error) {
    console.error('Error generating article embedding:', error)
    return null
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Enhanced categorization using both rule-based and semantic approaches
 */
export async function categorizeArticleHybrid(
  title: string,
  summary?: string
): Promise<CategoryScore[]> {
  // Start with rule-based categorization
  const ruleBasedScores = categorizeArticle({ title, summary })

  // Get article embedding for semantic comparison
  const articleEmbedding = await generateArticleEmbedding(title, summary)

  if (!articleEmbedding) {
    // Fallback to rule-based only if embedding generation fails
    console.warn(`Failed to generate article embedding for "${title}", using rule-based only`)
    return ruleBasedScores
  }

  const hybridScores: CategoryScore[] = []

  // Process each category
  for (const category of CATEGORIES) {
    const ruleScore = ruleBasedScores.find((s) => s.slug === category.slug)
    const ruleConfidence = ruleScore?.confidence || 0

    // Get semantic similarity
    const categoryEmbedding = await getCategoryEmbedding(category.slug)
    let semanticConfidence = 0
    let hasSemanticScore = false

    if (categoryEmbedding) {
      const similarity = cosineSimilarity(articleEmbedding, categoryEmbedding)
      // Scale similarity to confidence with more gradual scaling
      // Maps 0.3-1.0 similarity to 0.0-1.0 confidence
      semanticConfidence = Math.max(0, Math.min(1.0, (similarity - 0.3) * 1.43))
      hasSemanticScore = true
    }

    // Combine rule-based and semantic scores
    // If semantic scoring failed, use rule-based only (don't penalize)
    // Otherwise: Weight 40% rule-based, 60% semantic (semantic embeddings are more accurate)
    const combinedConfidence = hasSemanticScore
      ? ruleConfidence * 0.4 + semanticConfidence * 0.6
      : ruleConfidence

    const reasons = [
      ...(ruleScore?.reasons || []),
      categoryEmbedding
        ? `Semantic similarity: ${semanticConfidence.toFixed(3)}`
        : 'No semantic score',
    ]

    hybridScores.push({
      slug: category.slug,
      confidence: Math.min(1.0, combinedConfidence),
      reasons,
    })
  }

  // Sort by confidence, highest first
  return hybridScores.sort((a, b) => b.confidence - a.confidence)
}

/**
 * Store article categories in database
 */
export async function storeArticleCategories(
  articleId: number,
  scores: CategoryScore[],
  minConfidence: number = 0.35
): Promise<void> {
  try {
    // Filter scores by minimum confidence
    const validScores = scores.filter((s) => s.confidence >= minConfidence)

    if (validScores.length === 0) {
      console.log(
        `No categories with sufficient confidence for article ${articleId}`
      )
      return
    }

    // Find primary category (highest confidence)
    const primaryCategory = validScores[0]

    // Clear existing categories for this article
    await query('DELETE FROM article_categories WHERE article_id = $1', [
      articleId,
    ])

    // Insert new categories
    for (const score of validScores) {
      await query(
        `
        INSERT INTO article_categories (article_id, category_id, confidence, is_primary)
        SELECT $1, c.id, $2, $3
        FROM categories c 
        WHERE c.slug = $4
      `,
        [
          articleId,
          score.confidence,
          score.slug === primaryCategory.slug,
          score.slug,
        ]
      )
    }

    console.log(
      `Stored ${validScores.length} categories for article ${articleId}, primary: ${primaryCategory.slug}`
    )
  } catch (error) {
    console.error(`Error storing categories for article ${articleId}:`, error)
    throw error
  }
}

/**
 * Categorize and store an article's categories
 */
export async function categorizeAndStoreArticle(
  articleId: number,
  title: string,
  summary?: string
): Promise<void> {
  try {
    const scores = await categorizeArticleHybrid(title, summary)
    await storeArticleCategories(articleId, scores)
  } catch (error) {
    console.error(`Error categorizing article ${articleId}:`, error)
    throw error
  }
}

