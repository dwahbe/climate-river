# Reader View Documentation

A clean, minimal reader view feature for articles using Defuddle (backend) and Vaul + Tailwind Typography (frontend).

---

## Table of Contents

1. [Overview](#overview)
2. [What Works & Limitations](#what-works--limitations)
3. [Architecture](#architecture)
4. [Backend Implementation](#backend-implementation)
5. [Frontend Components](#frontend-components)
6. [Database Schema](#database-schema)
7. [API Documentation](#api-documentation)
8. [Performance & Monitoring](#performance--monitoring)
9. [Deployment Guide](#deployment-guide)
10. [Testing](#testing)
11. [Legal & Future Work](#legal--future-work)

---

## Overview

The reader view provides a distraction-free reading experience by:

- Extracting clean article content from URLs using Defuddle
- Caching content in the database (7-day TTL)
- Displaying in a responsive UI (side drawer on desktop, bottom sheet on mobile)
- Gracefully handling paywalls, bot detection, and timeouts

---

## What Works & Limitations

### ✅ Works Well

- **Open access news**: The Guardian, BBC, AP, Reuters, PBS, NPR
- **Climate blogs**: CleanTechnica, Grist, Yale E360, Carbon Brief
- **Regional papers**: Local news without strict paywalls
- **Government/research**: NOAA, NASA, academic sites
- **Soft paywalls**: Sometimes works if content shown for SEO

### ❌ Won't Work (Paywalls)

- **NYTimes**, **Bloomberg**, **WSJ**, **Financial Times**, **Washington Post**
- Hard paywalls return graceful error messages with "Read on original site" fallback

### ⚠️ May Work Sometimes

- **Medium**: Depends on publisher settings
- **Substack**: Public posts work, subscriber-only don't
- **Bot-protected sites**: CloudFlare/Akamai may block

---

## Architecture

```
┌─────────────┐
│   User      │ Clicks "Read now"
└─────┬───────┘
      │
      ▼
┌────────────────────────┐
│ ReadNowButton          │
│ (components/)          │
└────────┬───────────────┘
         │
         ▼
┌────────────────────────┐
│ ReaderView             │
│ - Mobile: Vaul drawer  │
│ - Desktop: Side panel  │
└────────┬───────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  API: /api/reader/[articleId]  │
│  (Vercel Serverless Function)  │
└────────┬────────────────────────┘
         │
         ▼
    Cache Check (DB)
         │
    ┌────┴────┐
    │         │
 Found    Not Found
    │         │
    │         ▼
    │    Fetch URL
    │         │
    │    ┌────┴────┐
    │    │ JSDOM   │ Parse HTML
    │    └────┬────┘
    │         │
    │    ┌────┴────┐
    │    │Defuddle │ Extract & clean
    │    └────┬────┘
    │         │
    │    Detect:
    │    - Paywall?
    │    - Blocked?
    │    - Error?
    │         │
    └─────┬───┘
          │
          ▼
    Store in DB
          │
          ▼
    Return to client
```

---

## Backend Implementation

### Core Service: `lib/services/readerService.ts`

**Key Functions:**

- `getArticleContent(articleId)` - Main entry point, checks cache first
- `fetchArticleContentFromUrl(url)` - Fetches and extracts content
- `stripHtml(html)` - Converts HTML to plain text
- `calculateReadTime(wordCount)` - Estimates reading time

**Process:**

1. **Cache check**: Query DB for existing content (7-day TTL)
2. **Fetch**: If cache miss, fetch URL with timeout (8s)
3. **Parse**: Use JSDOM to create DOM from HTML
4. **Extract**: Defuddle extracts main content
5. **Clean**: Regex-based cleanup removes unwanted tags/attributes
6. **Detect**: Check for paywall/blocking indicators
7. **Store**: Save to DB with status (`success`, `paywall`, `blocked`, `timeout`, `error`)
8. **Return**: Send content or error to client

**Optimizations:**

- Dynamic imports for JSDOM/Defuddle (reduces cold start)
- Aggressive HTML cleanup (removes style, script, nav, footer, aside, svg)
- Explicit JSDOM cleanup (`dom.window.close()`)
- 8-second timeout (buffer for Vercel's 10s limit)

### API Route: `app/api/reader/[articleId]/route.ts`

- **Runtime**: `nodejs` (required for pg pooling)
- **Exports**: `GET` handler
- **Returns**: JSON with content or error
- **Status codes**: 200 (success), 402 (paywall), 403 (blocked), 404 (not found), 408 (timeout), 500 (error)

---

## Frontend Components

### 1. `components/ReadNowButton.tsx`

- Small, subtle button ("Read now")
- Positioned in upper right, same line as article source
- Manages `isOpen` state for `ReaderView`
- Future: Could support `disabled` prop for known paywalls

### 2. `components/ReaderView.tsx`

**Architecture:**

- Uses Vaul for both mobile AND desktop (with `direction` prop)
- Detects screen size with `window.innerWidth < 768`
- Single `Drawer.Root` with responsive styling

**Desktop (≥ 768px):**

- Side drawer from right (`direction="right"`)
- 45% width
- 8px gap from edges (`--initial-transform: 'calc(100% + 8px)'`)
- Rounded left corners (`rounded-l-[16px]`)
- X button in corner
- Overlay dims background

**Mobile (< 768px):**

- Bottom drawer (`direction="bottom"`)
- 90% height
- Drag handle visible
- Swipe down to close
- No X button needed

**Features:**

- Loading spinner while fetching
- Error messages for paywalls/blocks/timeouts
- Metadata display (title, author, read time, original link)
- Clean typography with Tailwind Prose (`prose-lg` on desktop)
- Accessibility: `Drawer.Title` and `Drawer.Description` for screen readers

### Integration: `app/page.tsx`

```tsx
<ReadNowButton
  articleId={r.lead_article_id}
  articleTitle={r.lead_title}
  articleUrl={r.lead_url}
/>
```

---

## Database Schema

Added to `articles` table:

```sql
content_html         TEXT        -- Extracted HTML content
content_text         TEXT        -- Plain text version (for search)
content_word_count   INT         -- Word count
content_fetched_at   TIMESTAMPTZ -- When content was fetched
content_status       TEXT        -- 'success', 'paywall', 'timeout', 'blocked', 'error'
content_error        TEXT        -- Error message if failed

-- Indexes
CREATE INDEX idx_articles_content_status ON articles(content_status);
CREATE INDEX idx_articles_content_fetched_at ON articles(content_fetched_at)
  WHERE content_fetched_at IS NOT NULL;
```

**Migration:** `supabase/migrations/20250930_add_reader_content_columns.sql`

---

## API Documentation

### Request

```bash
GET /api/reader/[articleId]
```

### Success Response (200)

```json
{
  "success": true,
  "data": {
    "content": "<article>...</article>",
    "title": "Article Title",
    "author": "Author Name",
    "wordCount": 1234,
    "publishedAt": "2025-09-30T12:00:00Z"
  },
  "timing": {
    "elapsed": 123
  }
}
```

### Error Responses

| Status | Type      | Message                            |
| ------ | --------- | ---------------------------------- |
| 402    | paywall   | Article requires subscription      |
| 403    | blocked   | Publisher blocked automated access |
| 404    | not_found | Article not found in database      |
| 408    | timeout   | Request timed out after 8000ms     |
| 500    | error     | Internal server error              |

---

## Performance & Monitoring

### Performance Characteristics

| Scenario       | Time      | Notes                          |
| -------------- | --------- | ------------------------------ |
| Cold start     | 2-4s      | JSDOM + Defuddle load (~5MB)   |
| Warm cache hit | 50-200ms  | Direct DB query                |
| Fresh fetch    | 3-8s      | Network + parsing + extraction |
| Memory usage   | 100-300MB | Peak per request               |

**Cache TTL:** 7 days

### Monitoring Queries

**Success rate by status:**

```sql
SELECT
  content_status,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
FROM articles
WHERE content_fetched_at > NOW() - INTERVAL '7 days'
GROUP BY content_status;
```

**Cache age distribution:**

```sql
SELECT
  EXTRACT(EPOCH FROM (NOW() - content_fetched_at)) / 3600 as age_hours,
  COUNT(*)
FROM articles
WHERE content_status = 'success'
GROUP BY 1
ORDER BY 1;
```

**Top domains by success/failure:**

```sql
SELECT
  REGEXP_REPLACE(canonical_url, '^https?://([^/]+).*', '\1') as domain,
  content_status,
  COUNT(*) as count
FROM articles
WHERE content_fetched_at > NOW() - INTERVAL '7 days'
GROUP BY domain, content_status
ORDER BY count DESC
LIMIT 20;
```

### Log Messages

```
📖 Fetched https://example.com in 1234ms - SUCCESS
📖 Fetched https://nytimes.com in 567ms - paywall
🔄 Cache miss/expired for article 123, fetching...
Reader API: article 123 - SUCCESS in 1867ms (cache: false)
```

---

## Deployment Guide

### Dependencies

**Production:**

- `defuddle` - Content extraction
- `jsdom` - HTML parsing
- `vaul` - Drawer component
- `@tailwindcss/typography` - Prose styles
- `lucide-react` - Icons

**Dev:**

- `@types/jsdom`

### Steps

1. **Install dependencies:**

   ```bash
   npm install defuddle jsdom vaul @tailwindcss/typography lucide-react
   npm install -D @types/jsdom
   ```

2. **Run migration:**

   ```bash
   supabase db push
   # Or run manually: supabase/migrations/20250930_add_reader_content_columns.sql
   ```

3. **Test locally:**

   ```bash
   npm run dev
   # Visit: http://localhost:3000
   # Click "Read now" on any article
   ```

4. **Deploy:**
   ```bash
   git add .
   git commit -m "Add reader view feature"
   git push
   # Vercel auto-deploys
   ```

### Cost Estimates (Vercel Hobby)

- **GB-Hours**: ~0.17 per 1000 requests
- **Hobby Limit**: 100 GB-Hours/month = ~600k requests
- **With caching**: Easily support 100k article views/month
- **Bandwidth**: 100GB/month limit; 2M cached + 100k fresh fetches
- **Verdict**: Plenty of headroom for MVP

---

## Testing

### Manual Testing

**Desktop:**

- ✅ Button appears on article cards
- ✅ Side drawer slides in from right (45% width)
- ✅ Article list shifts left
- ✅ Overlay dims background
- ✅ X button closes drawer
- ✅ Click overlay closes drawer
- ✅ Content loads and displays
- ✅ Links work in reader view
- ✅ Smooth animations

**Mobile:**

- ✅ Drawer slides up from bottom (90% height)
- ✅ Drag handle visible
- ✅ Swipe down closes drawer
- ✅ Tap outside closes drawer
- ✅ Content displays correctly

**Error Cases:**

- ✅ Paywalled articles show error message
- ✅ Blocked articles show fallback
- ✅ Timeouts handled gracefully
- ✅ "Read on original site" link always works

### Performance Testing

**Test caching:**

```bash
# First request: slow (3-8s)
time curl http://localhost:3000/api/reader/123

# Second request: fast (~100ms)
time curl http://localhost:3000/api/reader/123
```

**Load testing:**

```bash
npm install -g autocannon
autocannon -c 10 -d 30 http://localhost:3000/api/reader/123
```

---

## Legal & Future Work

### Legal Considerations

**Fair Use Arguments:**

1. Transformative use (reading, not republishing)
2. Personal use (users reading accessible content)
3. Cache/proxy (like browser reader mode)
4. Attribution (always links to original)

**Protections:**

- 7-day cache (not permanent archival)
- User-initiated (not automatic scraping)
- Proper User-Agent with contact info
- No content redistribution
- No ads on reader view

**Red Flags to Avoid:**

- ❌ Creating RSS from scraped content
- ❌ Showing ads on reader pages
- ❌ Indefinite archival
- ❌ Stripping attribution

### Future Enhancements

**Backend:**

1. Maintain paywall domain list (skip fetch, instant error)
2. Content quality scoring (word count thresholds)
3. Background prefetching for top articles
4. Switch to API service (Jina Reader) if better

**Frontend:**

1. Navigation: Previous/Next buttons for cluster articles
2. Settings: Font size, font family toggles
3. Dark mode: Prose-invert class toggle
4. Reading progress: Scroll indicator
5. Keyboard shortcuts: J/K nav, ESC close
6. Share/Bookmark functionality

**Analytics:**

- Track opens per article
- Measure read time (scroll depth)
- Success/error rates by source
- Most-read via reader view

---

## Quick Reference

### File Structure

```
app/
  api/reader/[articleId]/route.ts   # API endpoint
  page.tsx                           # Integrates ReadNowButton
  global.css                         # Imports @tailwindcss/typography

components/
  ReadNowButton.tsx                  # Button component
  ReaderView.tsx                     # Drawer/panel UI

lib/
  services/readerService.ts          # Core extraction logic

supabase/migrations/
  20250930_add_reader_content_columns.sql
```

### Commands

```bash
npm run dev              # Local dev server
npm run build            # Production build
supabase db push         # Apply migrations
```

---

**Status:** ✅ Production Ready  
**Last Updated:** September 30, 2025
