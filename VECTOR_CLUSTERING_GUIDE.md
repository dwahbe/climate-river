# Vector-Based Semantic Clustering

Climate River now uses AI-powered semantic clustering to group related articles using vector embeddings instead of simple keyword matching.

## 🚀 **How It Works**

1. **Embedding Generation**: Each article's title and description are converted to vector embeddings using OpenAI's `text-embedding-3-small` model
2. **Semantic Similarity**: Articles are clustered based on cosine similarity of their embeddings (threshold: 0.85)
3. **Intelligent Clustering**: Related articles automatically group together even when using different terminology

## 📊 **Benefits Over Keyword Clustering**

| **Old System**                                      | **New System**              |
| --------------------------------------------------- | --------------------------- |
| "Tesla factory Texas" ≠ "Musk manufacturing Austin" | ✅ Semantic understanding   |
| "Hurricane coastal" ≠ "Storm surge waterfront"      | ✅ Synonym recognition      |
| "Climate change policy" = false positives           | ✅ Context awareness        |
| Manual keyword tuning                               | ✅ AI-powered understanding |

## 🗄️ **Database Changes**

### Migration Required

Run this SQL in your Supabase dashboard:

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column
ALTER TABLE articles ADD COLUMN embedding vector(1536);

-- Create similarity index
CREATE INDEX articles_embedding_idx ON articles
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

## 🔧 **Setup Instructions**

### 1. Apply Database Migration

```bash
# Copy the SQL from supabase/migrations/20250103_enable_pgvector.sql
# Run it in your Supabase SQL editor
```

### 2. Backfill Existing Articles

```bash
npm run backfill-embeddings
```

### 3. Future Articles

New articles automatically get embeddings during ingestion:

```bash
npm run ingest
```

## 💰 **Cost Optimization**

- **Model**: `text-embedding-3-small` (62% cheaper than ada-002)
- **Rate Limiting**: 100ms between API calls
- **Batch Processing**: 100 articles per backfill run
- **Cost**: ~$0.02 per 10,000 articles

## 🎯 **Similarity Thresholds**

| **Threshold** | **Use Case**                  |
| ------------- | ----------------------------- |
| 0.95+         | Near-identical articles       |
| 0.80-0.95     | Closely related stories       |
| 0.70-0.80     | Related stories               |
| **0.65-0.70** | **Related stories** (current) |
| 0.60-0.65     | Loosely related               |
| <0.60         | Different topics              |

## 🔍 **Example Clusters**

**Energy Storage Policy** cluster might include:

- "California mandates grid-scale batteries"
- "New regulations boost energy storage deployment"
- "Battery storage requirements reshape utility sector"

**Climate Finance** cluster might include:

- "Green bonds reach record $500B"
- "Climate funding surges in developing nations"
- "ESG investment strategies gain momentum"

## 🛠️ **Monitoring & Debugging**

### Check Clustering Status

```sql
-- Articles with embeddings
SELECT COUNT(*) FROM articles WHERE embedding IS NOT NULL;

-- Recent clusters
SELECT c.id, c.key, COUNT(ac.article_id) as article_count
FROM clusters c
JOIN article_clusters ac ON c.id = ac.cluster_id
WHERE c.created_at >= NOW() - INTERVAL '24 hours'
GROUP BY c.id, c.key
ORDER BY article_count DESC;
```

### Performance Monitoring

```sql
-- Similarity search performance
EXPLAIN ANALYZE
SELECT 1 - (embedding <=> $1::vector) as similarity
FROM articles
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT 10;
```

## 🔮 **Future Enhancements**

- **Hybrid Clustering**: Combine semantic + keyword for edge cases
- **Dynamic Thresholds**: Adjust similarity based on topic diversity
- **Cluster Summaries**: AI-generated cluster descriptions
- **User Feedback**: Manual cluster adjustments
