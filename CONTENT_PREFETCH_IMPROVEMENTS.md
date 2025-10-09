# Content Prefetch & Defuddle Improvements

## Problem Identified

Previously, article content was **only fetched on-demand** when users clicked "Read Now". This caused:

1. ❌ Many article previews appearing empty or incomplete
2. ❌ Users experiencing fetch failures in real-time
3. ❌ No visibility into content extraction success rates
4. ❌ Slower user experience (waiting for content to load)

## Solution Implemented

### 1. **Proactive Content Prefetching**

Created new script `/scripts/prefetch-content.ts` that:

- Fetches article content shortly after ingestion
- Runs automatically as part of cron jobs
- Focuses on recent articles (last 24 hours)
- Skips known paywall sites (NYT, WSJ, FT, Economist)
- Uses controlled concurrency (3 simultaneous fetches)
- Provides detailed statistics on success/failure rates

**Usage:**

```bash
# Manual run
npm run prefetch

# Automatically runs after ingestion in cron jobs
```

### 2. **Improved Defuddle Configuration**

Enhanced `/lib/services/readerService.ts`:

**Before:**

```typescript
const result = await Defuddle(dom, url, {
  debug: false,
  markdown: false,
})
const TIMEOUT = 8000 // 8 seconds
```

**After:**

```typescript
const result = await Defuddle(dom, url, {
  debug: false,
  markdown: true, // Cleaner, more reliable extraction
  minContentLength: 200, // Ensure substantial content
})
const TIMEOUT = 12000 // 12 seconds for slower sites
```

**Key improvements:**

- ✅ **Markdown mode**: Produces cleaner, more reliable content extraction
- ✅ **Increased timeout**: 12s instead of 8s for slower sites
- ✅ **Better User-Agent**: More realistic Mozilla string
- ✅ **AbortSignal**: Proper timeout handling
- ✅ **Accept-Encoding**: Support for gzip/brotli
- ✅ **Minimal cleanup**: Let Defuddle do the heavy lifting

### 3. **Markdown to HTML Conversion**

Added lightweight markdown-to-HTML converter:

- Handles headers, bold, italic, links, images
- Converts paragraphs properly
- No external dependencies needed
- Works with Tailwind's `prose` classes

### 4. **Integrated into Cron Jobs**

**Daily cron** (`/app/api/cron/daily/route.ts`):

- Prefetches up to **50 articles** after ingestion
- Runs during nightly comprehensive jobs

**Light cron** (`/app/api/cron/light/route.ts`):

- Prefetches up to **20 articles** after ingestion
- Runs every few hours during business hours

## Expected Benefits

### For Users

- ✅ **Instant article loading** (content pre-cached)
- ✅ **More complete article previews** (higher success rate)
- ✅ **Better reading experience** (cleaner markdown-based content)

### For Operations

- ✅ **Visibility into extraction success rates**
- ✅ **Proactive failure detection** (see issues in logs, not from users)
- ✅ **Better content quality** (markdown mode is more reliable)

### Performance

- ✅ **Controlled concurrency** (3 simultaneous fetches)
- ✅ **Smart filtering** (skips known paywalls)
- ✅ **Efficient caching** (7-day TTL)

## Testing

### Manual Testing

```bash
# Test prefetch script directly
npm run prefetch

# Test with custom limits
tsx --env-file=.env.local scripts/prefetch-content.ts
```

### Monitor in Production

Check cron job responses for prefetch statistics:

```json
{
  "prefetch": {
    "total": 50,
    "stats": {
      "success": 38,
      "paywall": 7,
      "blocked": 3,
      "timeout": 2
    },
    "duration": 45
  }
}
```

## Configuration

### Environment Variables

No new environment variables needed. Uses existing:

- Database connection (from `@/lib/db`)
- Timeout settings (in code)

### Adjustable Parameters

In cron jobs:

```typescript
// Daily: 50 articles
limit: 50

// Light: 20 articles
limit: 20

// In prefetch-content.ts:
hoursAgo: 24 // How far back to look
concurrency: 3 // Simultaneous fetches
```

### Known Limitations

**Paywalls**: The following domains are automatically skipped:

- nytimes.com
- wsj.com
- ft.com
- economist.com

Add more to the exclusion list in `prefetch-content.ts` if needed.

## Monitoring

### Success Indicators

- Higher `success` count in prefetch stats
- Lower on-demand fetch requests in `/api/reader/[articleId]`
- Faster reader view loading times

### Failure Indicators

- High `paywall` or `blocked` counts
- Many `timeout` failures (may need to increase timeout)
- Low `success` rate (<70%)

### Troubleshooting

**Low success rate:**

1. Check Defuddle version (should be >=0.6.6)
2. Verify timeout is adequate (currently 12s)
3. Review blocked domains list
4. Check for anti-bot measures (Cloudflare, etc.)

**Timeouts:**

1. Increase `TIMEOUT` in `readerService.ts`
2. Reduce prefetch concurrency (currently 3)
3. Check network latency

**Memory issues:**

1. Reduce prefetch batch size
2. Ensure JSDOM cleanup is working (dom.window.close())
3. Monitor Vercel function memory usage

## Future Enhancements

Potential improvements to consider:

1. **Retry logic**: Retry failed fetches after a delay
2. **Proper markdown library**: Use `marked` or `remark` for better conversion
3. **Content summarization**: Generate AI summaries for long articles
4. **Image optimization**: Download and optimize article images
5. **Smart scheduling**: Prioritize high-traffic articles
6. **Publisher-specific extractors**: Custom logic for major publishers
7. **Metrics dashboard**: Visualize extraction success rates

## References

- [Defuddle GitHub](https://github.com/hgcummings/defuddle)
- [Article content schema](./schema.sql) (content_html, content_status columns)
- [Reader view component](./components/ReaderView.tsx)
