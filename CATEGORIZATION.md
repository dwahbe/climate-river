# Climate River Categorization System

## Overview

Climate River uses a **hybrid categorization system** that combines rule-based keyword matching with semantic embeddings to automatically categorize climate news articles into 6 topic categories.

## Categories

| Category          | Slug         | Description                                                |
| ----------------- | ------------ | ---------------------------------------------------------- |
| 🏛️ **Government** | `government` | Policy, legislation, regulation, international agreements  |
| 📊 **Business**   | `business`   | Corporate climate action, finance, ESG, markets            |
| 🔬 **Research**   | `research`   | Scientific studies, data, reports, academic findings       |
| 💻 **Tech**       | `tech`       | Clean energy innovation, carbon capture, climate solutions |
| 🌊 **Impacts**    | `impacts`    | Extreme weather, disasters, ecosystem changes              |
| ✊ **Activism**   | `justice`    | Protests, rallies, strikes, grassroots movements           |

## How It Works

### 1. Hybrid Scoring

Each article is scored against all categories using two methods:

#### **Rule-Based Scoring** (40% weight)

- Matches keywords and regex patterns in article title/content
- Each keyword match adds to the score
- Fast and deterministic

#### **Semantic Scoring** (60% weight)

- Uses OpenAI embeddings (`text-embedding-3-small`)
- Compares article embedding to category description embedding
- Cosine similarity scaled from 0.3-1.0 → 0.0-1.0 confidence

**Combined Confidence** = `(rule_score × 0.4) + (semantic_score × 0.6)`

### 2. Confidence Threshold

Articles must score **≥0.35 confidence** to be assigned to a category.

- One article can belong to multiple categories
- Most articles match 1-3 categories
- Some articles may not match any category (filtered out)

### 3. Storage

Categories are stored in the `article_categories` table:

```sql
article_id | category_id | confidence | matched_keywords | created_at
```

This enables:

- Fast filtering by category
- Confidence-based ranking
- Multi-category articles
- Analytics on category distribution

## Implementation

### Core Files

- **`lib/tagger.ts`** - Category definitions, keywords, regex patterns
- **`lib/categorizer.ts`** - Hybrid scoring logic, embedding generation
- **`scripts/categorize.ts`** - Bulk categorization script

### Database

- **`categories`** - Category metadata (name, description, slug)
- **`article_categories`** - Many-to-many relationship with confidence scores
- **`get_articles_by_category(slug, limit)`** - Supabase RPC function

### Categorization Flow

```
1. New article ingested
   ↓
2. Generate article embedding (title + dek)
   ↓
3. For each category:
   - Calculate rule-based score (keywords/patterns)
   - Calculate semantic score (embedding similarity)
   - Combine: 40% rule + 60% semantic
   ↓
4. Filter scores ≥ 0.35 confidence
   ↓
5. Store in article_categories table
   ↓
6. Article appears in relevant category tabs
```

## Category Tuning

To adjust category accuracy:

### Add/Remove Keywords

Edit `lib/tagger.ts`:

```typescript
{
  slug: 'activism',
  keywords: [
    'extinction rebellion',
    'fridays for future',
    // add more here
  ],
  patterns: [
    /(protest|rally|strike)/i,
  ]
}
```

### Adjust Weighting

Edit `lib/categorizer.ts`:

```typescript
// Change semantic vs rule-based balance
const combinedConfidence = ruleConfidence * 0.4 + semanticConfidence * 0.6
```

### Change Threshold

Edit `lib/categorizer.ts`:

```typescript
// Require higher/lower confidence
minConfidence: number = 0.35
```

## Re-categorization

To re-categorize existing articles after tuning:

```bash
# Re-categorize last 1000 uncategorized articles
npm run categorize

# Or with custom limit
npm run categorize -- --limit 500
```

This will:

1. Delete old categorizations for those articles
2. Re-apply the current categorization logic
3. Store new category assignments

## Performance

- **Categorization speed**: ~0.5-1s per article (OpenAI API latency)
- **Query performance**: Indexed on `article_id` and `category_id`
- **Embedding cache**: Article embeddings are reused across categories

## Cost

- OpenAI embeddings: ~$0.002 per article
- 300 articles/day ≈ $0.60/day ≈ $18/month

## Future Improvements

Potential enhancements:

- Cache category embeddings (they rarely change)
- Fine-tune embedding model on climate news
- Add sub-categories (e.g., Policy → Federal/State/International)
- User feedback loop to improve accuracy
- A/B test different confidence thresholds
