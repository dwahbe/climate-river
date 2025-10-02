# Headline Rewrite System Upgrade

**Date:** October 2, 2025  
**Status:** ✅ Implemented and Ready for Deployment

## 🎯 Overview

Upgraded the headline rewriting system to use Defuddler-extracted article content for **dramatically better headlines**, inspired by [Techmeme's dense, scannable style](https://techmeme.com/).

## 📊 Cost Analysis

| Metric                          | Before    | After     | Change           |
| ------------------------------- | --------- | --------- | ---------------- |
| **Input tokens**                | ~150      | ~300      | +150 tokens      |
| **Output tokens**               | ~40       | ~40       | No change        |
| **Cost per article**            | $0.000047 | $0.000077 | +$0.00003        |
| **Monthly cost (900 articles)** | $0.04     | $0.07     | **+$0.03/month** |
| **Processing time**             | ~15s      | ~15s      | No change        |

**Verdict:** Negligible cost increase for significantly better headlines.

---

## 🚀 Key Improvements

### 1. **Content-Enhanced Rewriting**

- Uses Defuddler-extracted article HTML/text when available
- Extracts first 600 characters (lede paragraphs) for context
- **5-layer safety system** prevents paywall/garbage content

### 2. **Techmeme-Inspired Prompt**

- Dense, factual, scannable style
- Climate-specific patterns for policy, legal, corporate, science, tech stories
- Includes 5 concrete example headlines
- Explicit guidance on numbers, specifics, structure

### 3. **Enhanced Validation**

- **Requires numbers** in every headline (Techmeme style)
- **Rejects vague language**: "game-changer", "revolutionary", "slams"
- **Rejects weak hedging**: "may", "could", "might", "possibly"
- **Climate context check**: Must include climate-related terms
- **Length optimization**: 80-170 chars (Techmeme density)

### 4. **Cost Optimizations**

- Reduced `maxOutputTokens` from 120 to 50 (headlines are short)
- Increased `temperature` from 0.2 to 0.3 (more natural phrasing)
- Content snippet limited to 600 chars (~150 tokens)

### 5. **Comprehensive Safety**

```
Layer 1: Database status check (only use content_status = 'success')
Layer 2: Minimum length (100 chars, 30 words)
Layer 3: Paywall detection (keyword scan)
Layer 4: Uniqueness ratio (30%+ unique words)
Layer 5: Detailed logging (track all rejections)
```

---

## 📝 Example Transformations

### Before (Title + Dek Only)

```
"Biden Administration Announces New Clean Energy Initiative"
```

### After (With Article Content)

```
"DOE announces $12 billion clean hydrogen program, targeting 10 million tons annual production by 2030"
```

---

### Before

```
"Court Blocks Pipeline Project"
```

### After

```
"DC Circuit blocks Keystone XL expansion, citing inadequate environmental review of 830k barrels/day capacity"
```

---

### Before

```
"New Research Shows Concerning Climate Trends"
```

### After

```
"Nature study finds global temperatures exceeding 1.5°C in 2024, marking first full-year breach of Paris target"
```

---

## 🔧 Technical Changes

### Files Modified

#### 1. `scripts/schema.ts`

Added columns to articles table:

```sql
-- Content storage (from Defuddler)
content_html, content_text, content_word_count
content_status, content_error, content_fetched_at

-- Rewrite tracking
rewritten_title, rewritten_at, rewrite_model, rewrite_notes

-- Indexes
CREATE INDEX idx_articles_content_status ON articles(content_status)
```

#### 2. `scripts/rewrite.ts` - Complete Rewrite

**New Functions:**

- `extractContentSnippet()` - Extracts lede with 5-layer safety
- `buildPrompt()` - Techmeme-style prompt with climate patterns
- `passesChecks()` - Enhanced validation with Techmeme requirements

**Updated Functions:**

- `fetchBatch()` - Now includes content fields
- `processOne()` - Uses content opportunistically with safeguards
- `generateWithOpenAI()` - Optimized parameters (temp 0.3, tokens 50)

**Key Parameters:**

```typescript
model: 'gpt-4o-mini'
temperature: 0.3 // Up from 0.2
maxOutputTokens: 50 // Down from 120
contentSnippet: 600 // Conservative limit
```

---

## 🛡️ Safety Mechanisms

### Content Rejection Scenarios

1. ✅ **No content available** → Falls back to title + dek
2. ✅ **Status is 'paywall'** → Skips content, uses title + dek
3. ✅ **Content too short (<100 chars)** → Rejects, uses title + dek
4. ✅ **Paywall keywords detected** → Rejects, uses title + dek
5. ✅ **Too few words (<30)** → Rejects, uses title + dek
6. ✅ **Too repetitive (<30% unique)** → Rejects, uses title + dek

### Headline Rejection Scenarios

1. ✅ **No numbers** → Fails validation
2. ✅ **Too short/long** → Fails validation
3. ✅ **Vague language** → Fails validation
4. ✅ **Weak hedging** → Fails validation
5. ✅ **Not climate-related** → Fails validation
6. ✅ **Same as original** → Fails validation

---

## 📊 Monitoring & Analytics

### Query: Content Usage Stats

```sql
SELECT
  CASE
    WHEN rewrite_notes LIKE '%with_content%' THEN 'Used Content'
    WHEN rewrite_notes LIKE '%no_content%' THEN 'No Content'
    WHEN rewrite_notes LIKE '%paywall%' THEN 'Paywall'
    WHEN rewrite_notes LIKE '%content_rejected%' THEN 'Content Rejected'
    ELSE 'Other'
  END as content_status,
  COUNT(*) as count,
  AVG(LENGTH(rewritten_title)) as avg_headline_length,
  AVG(LENGTH(rewritten_title) - LENGTH(title)) as avg_improvement
FROM articles
WHERE rewritten_at > now() - interval '7 days'
GROUP BY content_status
ORDER BY count DESC;
```

### Query: Quality Check

```sql
-- See examples of rejected content (to tune filters)
SELECT
  title,
  content_status,
  content_word_count,
  SUBSTRING(content_text, 1, 200) as preview
FROM articles
WHERE content_status = 'success'
  AND content_word_count < 150  -- Suspicious
LIMIT 10;
```

### Query: Headline Performance

```sql
-- Compare headline lengths with/without content
SELECT
  CASE WHEN rewrite_notes LIKE '%with_content%' THEN 'With Content' ELSE 'Without Content' END as type,
  COUNT(*) as count,
  AVG(LENGTH(rewritten_title)) as avg_length,
  MIN(LENGTH(rewritten_title)) as min_length,
  MAX(LENGTH(rewritten_title)) as max_length
FROM articles
WHERE rewritten_at > now() - interval '7 days'
  AND rewritten_title IS NOT NULL
GROUP BY type;
```

---

## 🎯 Techmeme Style Guide

### Structure Pattern

```
[WHO] [ACTION VERB] [WHAT with numbers], [WHY/IMPACT with details]
```

### Example Patterns by Story Type

**Policy:**

```
EPA finalizes power plant emissions rule, requiring coal facilities to cut CO2 80% by 2032, citing climate goals
```

**Corporate:**

```
Ørsted cancels 2.6GW New Jersey offshore wind project, cites supply chain costs and rate caps
```

**Legal:**

```
Federal appeals court blocks Mountain Valley Pipeline, citing insufficient climate impact review
```

**Science:**

```
Nature study finds Amazon emitting more CO2 than it absorbs, driven by 15% deforestation increase
```

**Technology:**

```
Form Energy demonstrates 100-hour iron-air battery, targets grid-scale seasonal storage
```

### Key Principles

1. **Lead with WHO** - Agency/company/court name first
2. **Numbers are mandatory** - $X billion, X%, X tons, X GW
3. **Specific entities** - "EPA" not "regulators", "Ørsted" not "company"
4. **Present tense** - "announces" not "announced"
5. **No hype** - Show with numbers, don't tell with adjectives
6. **Comma-separated clauses** - Natural flow, not complex sentences

---

## 🚀 Deployment Checklist

- [x] Schema migration added
- [x] Rewrite script updated
- [x] Type checking passes
- [x] Build succeeds
- [x] No linter errors
- [ ] Run schema migration on production DB
- [ ] Test manually with `npm run rewrite`
- [ ] Monitor logs for safety warnings
- [ ] Check analytics after 24 hours

---

## 🔄 Running Manually

### Test the rewrite script

```bash
npm run rewrite
```

### Run schema migration

```bash
npx tsx scripts/schema.ts
```

### Test with specific limit

```bash
npx tsx scripts/rewrite.ts --limit 5
```

---

## 📈 Expected Outcomes

### Short Term (Week 1)

- ~10-20% of headlines use article content (depending on reader usage)
- Headlines become noticeably more specific and informative
- Users click through more due to better preview information

### Medium Term (Month 1)

- As reader view usage grows, more articles have cached content
- Headline quality improves proportionally
- Can measure engagement lift through click analytics

### Long Term (Optional)

- Consider adding content prefetch step for lead articles
- Monitor which content sources provide best quality
- A/B test different snippet lengths

---

## 🎉 Success Metrics

Track these to measure impact:

1. **Content Usage Rate**
   - % of rewrites using article content
   - Target: 30%+ within 1 month

2. **Headline Quality**
   - Avg headline length (target: 120-150 chars)
   - % containing numbers (target: 80%+)
   - % passing all validation checks (target: 70%+)

3. **User Engagement**
   - Click-through rate on rewritten headlines
   - Time on article (shows headline accurately represented content)

4. **Cost Efficiency**
   - Monthly OpenAI spend (should stay under $0.10)
   - Cost per quality headline

---

## 🔍 Troubleshooting

### If headlines are too short

- Check if content is being fetched successfully
- Review `content_status` distribution
- May need to adjust validation thresholds

### If too many rejections

- Review console warnings during rewrite
- Check specific patterns causing failures
- May need to tune validation rules

### If cost increases unexpectedly

- Check average content snippet length in logs
- Verify maxOutputTokens is still 50
- Review temperature and retries settings

---

## 📚 References

- [Techmeme](https://techmeme.com/) - Headline style inspiration
- [OpenAI Pricing](https://openai.com/api/pricing/) - GPT-4o-mini costs
- [Defuddler](https://github.com/hgcummings/defuddle) - Content extraction
- READER_VIEW.md - Content fetching documentation

---

## 🎯 Next Steps

1. **Deploy to production**

   ```bash
   git add scripts/rewrite.ts scripts/schema.ts
   git commit -m "feat: upgrade headline rewriting with Techmeme-style and content awareness"
   git push
   ```

2. **Run migration**
   - Trigger via API or Vercel console
   - Or run locally: `npx tsx scripts/schema.ts`

3. **Monitor first batch**
   - Watch logs for safety warnings
   - Check rewrite success rate
   - Review generated headlines

4. **Iterate if needed**
   - Adjust validation thresholds
   - Tune content snippet length
   - Refine Techmeme patterns

---

**Implementation Complete! 🎉**

This upgrade brings professional, information-dense headlines to Climate River while maintaining strict cost control and safety guardrails.
