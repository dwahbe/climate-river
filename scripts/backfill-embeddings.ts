// scripts/backfill-embeddings.ts
import './_env'
import { query, endPool } from '@/lib/db'
import OpenAI from 'openai'

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

async function backfillEmbeddings() {
  console.log('Starting embedding backfill...')

  // Get articles without embeddings
  const articlesResult = await query<{
    id: number
    title: string
    dek: string | null
  }>(
    `SELECT id, title, dek 
     FROM articles 
     WHERE embedding IS NULL 
     ORDER BY fetched_at DESC 
     LIMIT 100` // Process in batches to avoid overwhelming OpenAI API
  )

  const articles = articlesResult.rows
  console.log(`Found ${articles.length} articles without embeddings`)

  let processed = 0
  let errors = 0

  for (const article of articles) {
    try {
      console.log(`Processing article ${article.id}: "${article.title}"`)

      const embedding = await generateEmbedding(
        article.title,
        article.dek ?? undefined
      )

      if (embedding.length > 0) {
        await query(
          `UPDATE articles 
           SET embedding = $1 
           WHERE id = $2`,
          [JSON.stringify(embedding), article.id]
        )
        processed++
        console.log(`✅ Updated embedding for article ${article.id}`)
      } else {
        console.log(`❌ Failed to generate embedding for article ${article.id}`)
        errors++
      }

      // Rate limiting: wait 100ms between requests
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch (error) {
      console.error(`Error processing article ${article.id}:`, error)
      errors++
    }
  }

  console.log(`\nBackfill complete!`)
  console.log(`✅ Processed: ${processed}`)
  console.log(`❌ Errors: ${errors}`)
  console.log(`📊 Total articles: ${articles.length}`)
}

// Run the backfill
backfillEmbeddings()
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
