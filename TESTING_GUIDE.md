# Testing Guide: Headline Rewrite Upgrade

## 🧪 Testing Strategy

We'll test in three phases:

1. **Schema Migration** - Ensure DB columns exist
2. **Local Testing** - Test rewrite logic with sample data
3. **Production Testing** - Monitor first batch in production

---

## Phase 1: Schema Migration ✅

### Step 1: Run Migration Locally (Safe)

```bash
# This is idempotent - safe to run multiple times
npx tsx scripts/schema.ts
```

**Expected output:**

```
Schema ensured ✅
```

**What it does:**

- Adds `content_html`, `content_text`, `content_word_count`, etc.
- Adds `rewritten_title`, `rewritten_at`, `rewrite_model`, `rewrite_notes`
- Creates indexes on `content_status`
- **Idempotent:** Won't break if columns already exist

### Step 2: Verify Columns Were Added

```sql
-- Run in Supabase SQL Editor
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'articles'
  AND column_name IN (
    'content_html', 'content_text', 'content_status',
    'rewritten_title', 'rewritten_at', 'rewrite_model'
  )
ORDER BY column_name;
```

**Expected:** 6+ rows showing all new columns

---

## Phase 2: Local Testing 🧪

### Test 1: Dry Run (No DB Changes)

Create a test file to verify the logic:

```bash
# Create test file
cat > scripts/test-rewrite.ts << 'EOF'
// scripts/test-rewrite.ts
import { query } from '@/lib/db'

// Test the extraction function
function extractContentSnippet(
  contentText: string | null,
  contentHtml: string | null,
  maxChars = 600
): string | null {
  const text = contentText || contentHtml
  if (!text) return null

  let cleaned = text.replace(/<[^>]+>/g, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (cleaned.length < 100) {
    console.warn('⚠️  Content too short (<100 chars), skipping')
    return null
  }

  const paywallPatterns = [
    /subscribe/i,
    /subscription/i,
    /sign in/i,
    /member/i,
    /premium/i,
  ]
  const firstPart = cleaned.slice(0, 200)
  if (paywallPatterns.some((p) => p.test(firstPart))) {
    console.warn('⚠️  Paywall detected in content, skipping')
    return null
  }

  const words = cleaned.split(/\s+/).filter((w) => w.length > 0)
  if (words.length < 30) {
    console.warn('⚠️  Content too few words (<30), skipping')
    return null
  }

  const uniqueWords = new Set(words.map((w) => w.toLowerCase()))
  if (uniqueWords.size < words.length * 0.3) {
    console.warn('⚠️  Content too repetitive, skipping')
    return null
  }

  const sentences = cleaned.split(/[.!?]+\s+/)
  let snippet = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (trimmed.length < 10) continue

    if (snippet.length + trimmed.length > maxChars) break
    snippet += (snippet ? ' ' : '') + trimmed + '.'
  }

  return snippet.length >= 50 ? snippet : null
}

async function testExtraction() {
  // Test 1: Good content
  const goodContent = 'The Environmental Protection Agency announced new regulations today. The rule requires power plants to reduce emissions by 80% by 2032. Industry groups have expressed concerns about implementation costs. The agency cited climate change mitigation as the primary justification.'

  console.log('\n🧪 Test 1: Good Content')
  const result1 = extractContentSnippet(goodContent, null)
  console.log('Result:', result1 ? '✅ PASS' : '❌ FAIL')
  console.log('Snippet length:', result1?.length)

  // Test 2: Paywall content
  const paywallContent = 'Subscribe to read this article. Get unlimited access with our premium membership.'

  console.log('\n🧪 Test 2: Paywall Content')
  const result2 = extractContentSnippet(paywallContent, null)
  console.log('Result:', !result2 ? '✅ PASS (correctly rejected)' : '❌ FAIL')

  // Test 3: Too short
  const shortContent = 'Short article.'

  console.log('\n🧪 Test 3: Too Short Content')
  const result3 = extractContentSnippet(shortContent, null)
  console.log('Result:', !result3 ? '✅ PASS (correctly rejected)' : '❌ FAIL')

  // Test 4: HTML content
  const htmlContent = '<p>The EPA announced new rules.</p><p>Power plants must cut emissions 80% by 2032.</p><p>This represents a major policy shift in climate regulation.</p><p>Industry groups are challenging the decision in federal court.</p>'

  console.log('\n🧪 Test 4: HTML Content')
  const result4 = extractContentSnippet(null, htmlContent)
  console.log('Result:', result4 ? '✅ PASS' : '❌ FAIL')
  console.log('Snippet length:', result4?.length)
  console.log('Has HTML tags:', result4?.includes('<') ? '❌ FAIL' : '✅ PASS')
}

async function testValidation() {
  console.log('\n\n═══════════════════════════════════')
  console.log('🧪 Testing Validation Logic')
  console.log('═══════════════════════════════════\n')

  function passesChecks(original: string, draft: string, hasContent: boolean) {
    if (!draft) return false
    const t = draft.trim()

    if (t.length < 80 || t.length > 170) {
      console.warn(`  ⚠️  Length check failed (${t.length} chars)`)
      return false
    }

    const hasNumber = /\d/.test(t)
    if (!hasNumber) {
      console.warn(`  ⚠️  No numbers in headline`)
      return false
    }

    const badPatterns = [
      /\bmajor\b.*\bbreakthrough\b/i,
      /\bgame.?chang/i,
      /\brevolutionary\b/i,
    ]

    if (badPatterns.some((p) => p.test(t))) {
      console.warn(`  ⚠️  Rejected vague/hype language`)
      return false
    }

    const climateTerms = [
      /\b(climate|carbon|emission|renewable|fossil|solar|wind|epa|greenhouse|warming|energy|environmental?)\b/i,
    ]

    if (!climateTerms.some((p) => p.test(t))) {
      console.warn(`  ⚠️  Rejected non-climate headline`)
      return false
    }

    return true
  }

  // Test cases
  const tests = [
    {
      name: 'Good Headline',
      original: 'EPA Announces New Rule',
      draft: 'EPA finalizes power plant emissions rule, requiring coal facilities to cut CO2 80% by 2032, citing climate goals',
      hasContent: true,
      shouldPass: true
    },
    {
      name: 'No Numbers',
      original: 'Company Makes Announcement',
      draft: 'Renewable energy company announces major solar project in California',
      hasContent: false,
      shouldPass: false
    },
    {
      name: 'Hype Language',
      original: 'New Technology',
      draft: 'Revolutionary carbon capture technology represents major breakthrough in climate change',
      hasContent: false,
      shouldPass: false
    },
    {
      name: 'Too Short',
      original: 'Climate News',
      draft: 'EPA announces new emissions standards for power plants',
      hasContent: false,
      shouldPass: false
    },
    {
      name: 'Not Climate Related',
      original: 'Tech Company News',
      draft: 'Apple announces new iPhone 16 with improved battery lasting 25 hours',
      hasContent: false,
      shouldPass: false
    }
  ]

  for (const test of tests) {
    console.log(`🧪 Test: ${test.name}`)
    const result = passesChecks(test.original, test.draft, test.hasContent)
    const status = result === test.shouldPass ? '✅ PASS' : '❌ FAIL'
    console.log(`   Result: ${status}`)
    console.log(`   Draft: "${test.draft.slice(0, 60)}..."`)
    console.log('')
  }
}

async function run() {
  console.log('═══════════════════════════════════')
  console.log('🧪 Testing Content Extraction')
  console.log('═══════════════════════════════════')

  await testExtraction()
  await testValidation()

  console.log('\n✅ Unit tests complete!')
}

run().catch(console.error)
EOF

# Run the tests
npx tsx scripts/test-rewrite.ts
```

**Expected output:**

- All extraction tests should pass
- Validation tests should correctly accept/reject headlines

---

### Test 2: Check Existing Articles

See what articles are available for rewriting:

```sql
-- Run in Supabase SQL Editor
SELECT
  id,
  title,
  dek,
  content_status,
  content_word_count,
  rewritten_title,
  published_at
FROM articles
WHERE rewritten_title IS NULL
  AND published_at > now() - interval '21 days'
ORDER BY fetched_at DESC
LIMIT 10;
```

**What to look for:**

- Articles without `rewritten_title` (candidates for rewriting)
- Check if any have `content_status = 'success'` (will get enhanced rewriting)
- Note the `id` of a few articles for targeted testing

---

### Test 3: Single Article Test

Test rewriting a single article:

```bash
# Create a single-article test script
cat > scripts/test-single.ts << 'EOF'
import { query } from '@/lib/db'
import * as rewrite from './rewrite'

async function testSingle(articleId: number) {
  console.log(`\n🧪 Testing rewrite for article ${articleId}\n`)

  // Fetch the article
  const result = await query<any>(
    `SELECT id, title, dek, content_text, content_html, content_status
     FROM articles WHERE id = $1`,
    [articleId]
  )

  if (result.rows.length === 0) {
    console.error('❌ Article not found')
    return
  }

  const article = result.rows[0]

  console.log('📰 Original Article:')
  console.log(`   Title: ${article.title}`)
  console.log(`   Dek: ${article.dek?.slice(0, 100)}...`)
  console.log(`   Content Status: ${article.content_status || 'none'}`)
  console.log(`   Content Length: ${article.content_text?.length || 0} chars`)

  console.log('\n🔄 Running rewrite...\n')

  // Run the rewrite (limit to just this article)
  await query(
    `UPDATE articles SET rewritten_title = NULL WHERE id = $1`,
    [articleId]
  )

  await rewrite.run({ limit: 1, closePool: true })

  // Check result
  const updated = await query<any>(
    `SELECT rewritten_title, rewrite_notes
     FROM articles WHERE id = $1`,
    [articleId]
  )

  if (updated.rows[0].rewritten_title) {
    console.log('\n✅ Success!')
    console.log(`   Rewritten: ${updated.rows[0].rewritten_title}`)
    console.log(`   Notes: ${updated.rows[0].rewrite_notes}`)
  } else {
    console.log('\n⚠️  Failed to rewrite')
    console.log(`   Notes: ${updated.rows[0].rewrite_notes}`)
  }
}

// Get article ID from command line
const articleId = parseInt(process.argv[2])
if (!articleId) {
  console.error('Usage: npx tsx scripts/test-single.ts <article_id>')
  process.exit(1)
}

testSingle(articleId).catch(console.error)
EOF

# Run with a specific article ID (replace 123 with actual ID from previous query)
npx tsx scripts/test-single.ts 123
```

---

### Test 4: Small Batch Test

Test with a small batch of articles:

```bash
# Run rewrite on just 5 articles
npm run rewrite -- --limit 5

# Or with tsx directly
npx tsx scripts/rewrite.ts
```

**What to watch for:**

```
📝 Processing 5 articles...
✅ [123] "EPA Announces..." → "EPA finalizes power plant emissions rule..."
✅ [124] "Study Shows..." → "Nature study finds Amazon emitting more CO2..."
⚠️  [125] Failed validation: "Tech Company Announces..."
✅ [126] "Court Blocks..." → "DC Circuit blocks Keystone XL expansion..."
⚠️  [127] Failed validation: "Breaking News..."

✅ Rewrite complete: 3 succeeded, 2 failed (4.2s)
```

---

### Test 5: Check Results

After running, verify the results:

```sql
-- Check what was rewritten
SELECT
  id,
  LEFT(title, 50) as original_title,
  LEFT(rewritten_title, 80) as rewritten,
  rewrite_notes,
  LENGTH(rewritten_title) as rewritten_length
FROM articles
WHERE rewritten_at > now() - interval '1 hour'
ORDER BY rewritten_at DESC
LIMIT 10;
```

**Quality checks:**

- ✅ Rewritten headlines should be 80-170 chars
- ✅ Should contain numbers
- ✅ Should be more specific than originals
- ✅ `rewrite_notes` should show if content was used

---

## Phase 3: Production Testing 🚀

### Step 1: Deploy

```bash
# Commit changes
git add scripts/rewrite.ts scripts/schema.ts HEADLINE_REWRITE_UPGRADE.md TESTING_GUIDE.md
git commit -m "feat: upgrade headline rewriting with Techmeme-style and content awareness"
git push
```

### Step 2: Run Migration in Production

**Option A: Via Vercel Function**

```bash
# Trigger schema migration via API (if you have an endpoint)
curl -X POST "https://your-app.vercel.app/api/schema?token=YOUR_ADMIN_TOKEN"
```

**Option B: Via Supabase SQL Editor**

```sql
-- Just run the ALTER TABLE commands manually in Supabase
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS content_html TEXT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS content_text TEXT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS content_word_count INT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS content_status TEXT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS content_error TEXT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS content_fetched_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS rewritten_title TEXT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS rewritten_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS rewrite_model TEXT;
ALTER TABLE IF EXISTS articles ADD COLUMN IF NOT EXISTS rewrite_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_content_status
  ON articles(content_status) WHERE content_status IS NOT NULL;
```

### Step 3: Monitor First Production Run

Trigger the rewrite job:

```bash
# Via API (if you have access)
curl "https://your-app.vercel.app/api/rewrite?token=YOUR_ADMIN_TOKEN&limit=10"
```

Or wait for the daily cron job to run automatically.

### Step 4: Check Production Logs

In Vercel Dashboard:

1. Go to your project
2. Click "Logs"
3. Filter for "rewrite"
4. Look for:
   - `✅` Success messages
   - `⚠️` Warning messages (content rejected, validation failed)
   - Error patterns

### Step 5: Analytics Queries

Run these after 24-48 hours:

```sql
-- Content usage breakdown
SELECT
  CASE
    WHEN rewrite_notes LIKE '%with_content%' THEN 'Used Content'
    WHEN rewrite_notes LIKE '%no_content%' THEN 'No Content'
    WHEN rewrite_notes LIKE '%paywall%' THEN 'Paywall'
    WHEN rewrite_notes LIKE '%blocked%' THEN 'Blocked'
    WHEN rewrite_notes LIKE '%content_rejected%' THEN 'Content Rejected'
    ELSE 'Other'
  END as content_status,
  COUNT(*) as count,
  ROUND(AVG(LENGTH(rewritten_title)), 1) as avg_length,
  ROUND(AVG(LENGTH(rewritten_title) - LENGTH(title)), 1) as avg_chars_added
FROM articles
WHERE rewritten_at > now() - interval '24 hours'
GROUP BY content_status
ORDER BY count DESC;
```

```sql
-- Quality metrics
SELECT
  COUNT(*) as total_rewrites,
  COUNT(*) FILTER (WHERE rewritten_title ~ '\d') as has_numbers,
  ROUND(AVG(LENGTH(rewritten_title)), 1) as avg_length,
  MIN(LENGTH(rewritten_title)) as min_length,
  MAX(LENGTH(rewritten_title)) as max_length,
  COUNT(*) FILTER (WHERE LENGTH(rewritten_title) BETWEEN 80 AND 170) as in_target_range
FROM articles
WHERE rewritten_at > now() - interval '24 hours'
  AND rewritten_title IS NOT NULL;
```

```sql
-- Success rate
SELECT
  COUNT(*) FILTER (WHERE rewritten_title IS NOT NULL) as succeeded,
  COUNT(*) FILTER (WHERE rewritten_title IS NULL AND rewrite_notes IS NOT NULL) as failed,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE rewritten_title IS NOT NULL) /
    COUNT(*), 1
  ) as success_rate_pct
FROM articles
WHERE rewrite_model IS NOT NULL
  AND rewritten_at > now() - interval '24 hours';
```

---

## 🐛 Troubleshooting

### Issue: No articles being rewritten

**Check 1:** Are there articles without rewritten_title?

```sql
SELECT COUNT(*)
FROM articles
WHERE rewritten_title IS NULL
  AND published_at > now() - interval '21 days';
```

**Check 2:** Is OpenAI API key set?

```bash
# Check env vars (don't print the key!)
echo "OpenAI key set: $([ -n "$OPENAI_API_KEY" ] && echo 'YES' || echo 'NO')"
```

### Issue: All rewrites failing validation

**Check:** Look at the draft headlines and notes

```sql
SELECT
  title,
  rewrite_notes
FROM articles
WHERE rewrite_notes LIKE '%failed%'
  AND rewritten_at > now() - interval '1 hour'
LIMIT 5;
```

Common issues:

- No numbers in headlines → LLM not following instructions
- Too short → Need to adjust validation threshold
- No climate terms → Wrong articles being processed

### Issue: Content never being used

**Check:** Content status distribution

```sql
SELECT
  content_status,
  COUNT(*) as count
FROM articles
WHERE fetched_at > now() - interval '7 days'
GROUP BY content_status
ORDER BY count DESC;
```

If most are NULL:

- Reader view hasn't been used much yet
- This is expected! Content usage will grow over time

---

## ✅ Success Criteria

Your implementation is working if:

1. ✅ **Schema migration runs** without errors
2. ✅ **Unit tests pass** (content extraction + validation)
3. ✅ **Small batch test** produces 50%+ success rate
4. ✅ **Rewritten headlines**:
   - Are 80-170 characters
   - Contain numbers
   - Are more specific than originals
   - Pass climate-context check
5. ✅ **Content usage** (when available):
   - `rewrite_notes` shows "with_content"
   - Headlines include details from article body
6. ✅ **Graceful degradation**:
   - Paywall content is rejected
   - Falls back to title+dek when no content
7. ✅ **Cost tracking**:
   - OpenAI costs remain under $0.10/month

---

## 📋 Quick Start Checklist

- [ ] Run schema migration: `npx tsx scripts/schema.ts`
- [ ] Verify columns exist in Supabase
- [ ] Run unit tests: `npx tsx scripts/test-rewrite.ts`
- [ ] Test small batch: `npx tsx scripts/rewrite.ts`
- [ ] Check results in database
- [ ] Deploy to production
- [ ] Monitor first production run
- [ ] Run analytics queries after 24 hours
- [ ] Iterate on thresholds if needed

---

**Happy Testing! 🚀**
