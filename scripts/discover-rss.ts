// scripts/discover-rss.ts
// Discovers RSS feeds for outlets currently using web:// scheme
import { query, endPool } from '@/lib/db'
import Parser from 'rss-parser'

const parser = new Parser({
  headers: {
    'User-Agent': 'ClimateRiverBot/0.1 (+https://climateriver.org)',
  },
  requestOptions: { timeout: 10000 },
})

// Domains known to block/hang - skip these
const SKIP_DOMAINS = new Set([
  'washingtonpost.com', // Aggressive bot protection
  'reuters.com', // Requires authentication
  'bloomberg.com', // Paywalled
  'bbc.com', // Complex site structure
  'apnews.com', // Already have RSS in main sources
  'nytimes.com', // Already have RSS in main sources
  'theguardian.com', // Already have RSS in main sources
])

// Common RSS feed paths to probe
const RSS_PATHS = [
  '/feed',
  '/feed/',
  '/rss',
  '/rss/',
  '/feed.xml',
  '/rss.xml',
  '/atom.xml',
  '/feeds/posts/default',
  '/blog/feed',
  '/blog/rss',
  '/news/feed',
  '/news/rss',
  '/index.xml',
  '/.rss',
  '/feed/atom',
  '/feed/rss',
]

type DiscoveredFeed = {
  sourceId: number
  sourceName: string
  domain: string
  feedUrl: string
  itemCount: number
}

async function probeForRssFeed(
  domain: string
): Promise<{ feedUrl: string; itemCount: number } | null> {
  const baseUrl = `https://${domain}`

  for (const path of RSS_PATHS) {
    const url = `${baseUrl}${path}`
    try {
      const feed = await parser.parseURL(url)
      if (feed.items && feed.items.length > 0) {
        console.log(`  ✓ Found RSS at ${url} (${feed.items.length} items)`)
        return { feedUrl: url, itemCount: feed.items.length }
      }
    } catch {
      // Not a valid feed, continue
    }
  }

  // Also try to find RSS link in HTML
  try {
    const response = await fetch(baseUrl, {
      headers: {
        'User-Agent': 'ClimateRiverBot/0.1 (+https://climateriver.org)',
      },
      signal: AbortSignal.timeout(10000),
    })
    const html = await response.text()

    // Look for RSS link tags
    const rssMatch = html.match(
      /<link[^>]*type=["']application\/rss\+xml["'][^>]*href=["']([^"']+)["']/i
    )
    const atomMatch = html.match(
      /<link[^>]*type=["']application\/atom\+xml["'][^>]*href=["']([^"']+)["']/i
    )

    const feedLink = rssMatch?.[1] || atomMatch?.[1]
    if (feedLink) {
      // Resolve relative URLs
      const feedUrl = feedLink.startsWith('http')
        ? feedLink
        : new URL(feedLink, baseUrl).toString()

      try {
        const feed = await parser.parseURL(feedUrl)
        if (feed.items && feed.items.length > 0) {
          console.log(
            `  ✓ Found RSS via HTML at ${feedUrl} (${feed.items.length} items)`
          )
          return { feedUrl, itemCount: feed.items.length }
        }
      } catch {
        // Invalid feed URL in HTML
      }
    }
  } catch {
    // Could not fetch HTML
  }

  return null
}

async function discoverRssFeeds(): Promise<DiscoveredFeed[]> {
  // Get all sources with web:// scheme
  const { rows: webSources } = await query<{
    id: number
    name: string
    feed_url: string
  }>(`
    SELECT id, name, feed_url 
    FROM sources 
    WHERE feed_url LIKE 'web://%'
    ORDER BY name
  `)

  console.log(`Found ${webSources.length} sources using web:// scheme\n`)

  const discovered: DiscoveredFeed[] = []

  for (const source of webSources) {
    const domain = source.feed_url.replace('web://', '')

    // Skip known problematic domains
    if (SKIP_DOMAINS.has(domain)) {
      console.log(`Skipping ${source.name} (${domain}) - known to block/hang`)
      continue
    }

    console.log(`Probing ${source.name} (${domain})...`)

    const result = await probeForRssFeed(domain)
    if (result) {
      discovered.push({
        sourceId: source.id,
        sourceName: source.name,
        domain,
        feedUrl: result.feedUrl,
        itemCount: result.itemCount,
      })
    } else {
      console.log(`  ✗ No RSS feed found`)
    }
  }

  return discovered
}

async function updateSourcesWithFeeds(
  feeds: DiscoveredFeed[],
  dryRun = true
): Promise<void> {
  if (feeds.length === 0) {
    console.log('\nNo feeds to update.')
    return
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(
    `DISCOVERED ${feeds.length} RSS FEEDS${dryRun ? ' (DRY RUN)' : ''}`
  )
  console.log('='.repeat(60))

  for (const feed of feeds) {
    console.log(`\n${feed.sourceName}:`)
    console.log(`  Domain: ${feed.domain}`)
    console.log(`  Feed URL: ${feed.feedUrl}`)
    console.log(`  Items: ${feed.itemCount}`)

    if (!dryRun) {
      await query(`UPDATE sources SET feed_url = $1 WHERE id = $2`, [
        feed.feedUrl,
        feed.sourceId,
      ])
      console.log(`  → Updated in database`)
    }
  }

  if (dryRun) {
    console.log(`\n⚠️  DRY RUN - No changes made. Run with --apply to update.`)
  } else {
    console.log(`\n✓ Updated ${feeds.length} sources with discovered RSS feeds`)
  }
}

export async function run(opts: { apply?: boolean; closePool?: boolean } = {}) {
  const dryRun = !opts.apply

  console.log('RSS Feed Discovery')
  console.log('==================\n')

  const discovered = await discoverRssFeeds()
  await updateSourcesWithFeeds(discovered, dryRun)

  if (opts.closePool) {
    await endPool()
  }

  return { discovered, updated: !dryRun }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply')
  run({ apply, closePool: true })
    .then((result) => {
      console.log(`\nDiscovered ${result.discovered.length} RSS feeds`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('Error:', err)
      endPool().finally(() => process.exit(1))
    })
}
