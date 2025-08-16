import { query, endPool } from '@/lib/db'
import OpenAI from 'openai'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// Generate embedding for article content
async function generateEmbedding(
  title: string,
  description?: string
): Promise<number[]> {
  try {
    // Combine title and description for better semantic understanding
    const text = description ? `${title}\n\n${description}` : title

    // Truncate to prevent token limit issues (rough estimate: 1 token ≈ 4 chars)
    const truncatedText = text.substring(0, 8000)

    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small', // More cost-effective than text-embedding-ada-002
      input: truncatedText,
    })

    return response.data[0].embedding
  } catch (error) {
    console.error('Error generating embedding:', error)
    return []
  }
}

// Process a batch of articles
async function processBatch(
  articles: { id: number; title: string; dek: string | null }[],
  batchNumber: number
): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0

  console.log(
    `🔄 Batch ${batchNumber}: Processing ${articles.length} articles...`
  )

  for (const article of articles) {
    try {
      console.log(
        `  📝 Article ${article.id}: "${article.title.substring(0, 60)}..."`
      )

      const embedding = await generateEmbedding(
        article.title,
        article.dek ?? undefined
      )

      if (embedding.length > 0) {
        await query(
          `UPDATE articles 
           SET embedding = $1::vector 
           WHERE id = $2`,
          [JSON.stringify(embedding), article.id]
        )
        processed++
        console.log(`    ✅ Updated embedding for article ${article.id}`)
      } else {
        errors++
        console.log(
          `    ❌ Failed to generate embedding for article ${article.id}`
        )
      }

      // Rate limiting: wait 50ms between requests (reduced for parallel processing)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch (error) {
      console.error(`    ❌ Error processing article ${article.id}:`, error)
      errors++
    }
  }

  console.log(
    `✅ Batch ${batchNumber} complete: ${processed} processed, ${errors} errors`
  )
  return { processed, errors }
}

// Main backfill function with parallel processing
async function backfillEmbeddingsParallel() {
  console.log('🚀 Starting parallel embedding backfill...')

  // Get total count of articles without embeddings
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM articles WHERE embedding IS NULL`
  )
  const totalArticles = parseInt(countResult.rows[0].count)

  if (totalArticles === 0) {
    console.log('🎉 All articles already have embeddings!')
    return
  }

  console.log(`📊 Found ${totalArticles} articles without embeddings`)

  // Get all articles without embeddings
  const articlesResult = await query<{
    id: number
    title: string
    dek: string | null
  }>(
    `SELECT id, title, dek 
     FROM articles 
     WHERE embedding IS NULL 
     ORDER BY id DESC`
  )

  const articles = articlesResult.rows
  const batchSize = 25 // Smaller batches for parallel processing
  const maxConcurrentBatches = 4 // Process 4 batches simultaneously
  const batches: (typeof articles)[] = []

  // Split articles into batches
  for (let i = 0; i < articles.length; i += batchSize) {
    batches.push(articles.slice(i, i + batchSize))
  }

  console.log(
    `📦 Created ${batches.length} batches of ${batchSize} articles each`
  )
  console.log(`⚡ Processing up to ${maxConcurrentBatches} batches in parallel`)

  let totalProcessed = 0
  let totalErrors = 0

  // Process batches in parallel with controlled concurrency
  for (let i = 0; i < batches.length; i += maxConcurrentBatches) {
    const currentBatches = batches.slice(i, i + maxConcurrentBatches)

    console.log(
      `\n🔄 Processing batches ${i + 1}-${Math.min(i + maxConcurrentBatches, batches.length)}...`
    )

    const batchPromises = currentBatches.map((batch, index) =>
      processBatch(batch, i + index + 1)
    )

    const results = await Promise.all(batchPromises)

    for (const result of results) {
      totalProcessed += result.processed
      totalErrors += result.errors
    }

    console.log(
      `\n📊 Progress: ${totalProcessed + totalErrors}/${totalArticles} articles processed`
    )

    // Small delay between batch groups to avoid overwhelming the API
    if (i + maxConcurrentBatches < batches.length) {
      console.log('⏳ Waiting 2 seconds before next batch group...')
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  console.log('\n🎉 Parallel backfill complete!')
  console.log(`✅ Total processed: ${totalProcessed}`)
  console.log(`❌ Total errors: ${totalErrors}`)
  console.log(`📊 Total articles: ${totalProcessed + totalErrors}`)
}

// Run the backfill
backfillEmbeddingsParallel()
  .then(() => {
    console.log('Backfill completed successfully')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Backfill failed:', error)
    process.exit(1)
  })
  .finally(() => {
    endPool()
  })
