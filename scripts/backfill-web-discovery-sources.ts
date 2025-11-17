import { query, endPool } from '@/lib/db'

type ArticleRow = {
  id: number
  canonical_url: string
  publisher_name: string | null
  publisher_homepage: string | null
}

const HOST_BLOCKLIST = new Set([
  'news.google.com',
  'www.news.google.com',
  'news.yahoo.com',
  'www.news.yahoo.com',
  'msn.com',
  'www.msn.com',
])
const DEFAULT_WINDOW_HOURS = parseEnvInt('BACKFILL_HOURS', 168) // past week default
const BATCH_SIZE = parseEnvInt('BACKFILL_BATCH', 200)

const sourceCache = new Map<string, number>()

function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

function hostFromUrl(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function slugifyHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function humanizeHost(host: string): string {
  const core = host.replace(/\.[^.]+$/, '') // drop TLD for readability
  return core
    .split('.')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

async function getOrCreateSourceForHost(host: string, fallbackName?: string | null) {
  if (sourceCache.has(host)) {
    return { sourceId: sourceCache.get(host)!, name: fallbackName || humanizeHost(host) }
  }

  const slug = slugifyHost(host)
  const feedUrl = `web://${host}`
  const homepage = `https://${host}`
  const name = fallbackName?.trim() || humanizeHost(host)

  const existing = await query<{ id: number }>(
    `
      SELECT id
      FROM sources
      WHERE slug = $1
         OR feed_url = $2
         OR LOWER(COALESCE(homepage_url, '')) LIKE $3
      ORDER BY weight DESC
      LIMIT 1
    `,
    [slug, feedUrl, `%${host}%`]
  )

  let sourceId = existing.rows[0]?.id

  if (!sourceId) {
    const inserted = await query<{ id: number }>(
      `
        INSERT INTO sources (name, homepage_url, feed_url, weight, slug)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (feed_url) DO UPDATE
          SET name = EXCLUDED.name,
              homepage_url = EXCLUDED.homepage_url,
              weight = EXCLUDED.weight,
              slug = EXCLUDED.slug
        RETURNING id
      `,
      [name, homepage, feedUrl, 4, slug]
    )
    sourceId = inserted.rows[0]?.id
  }

  if (!sourceId) {
    throw new Error(`Unable to resolve source for host ${host}`)
  }

  sourceCache.set(host, sourceId)
  return { sourceId, name, homepage }
}

async function fetchWebDiscoveryArticles(limit: number): Promise<ArticleRow[]> {
  const { rows } = await query<ArticleRow>(
    `
      SELECT a.id, a.canonical_url, a.publisher_name, a.publisher_homepage
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      WHERE s.slug = 'web-discovery'
        AND a.canonical_url NOT LIKE 'https://news.google.com%'
        AND a.canonical_url NOT LIKE 'https://www.msn.com%'
        AND a.canonical_url NOT LIKE 'https://news.yahoo.com%'
        AND a.fetched_at >= NOW() - make_interval(hours => $1)
      ORDER BY a.fetched_at DESC
      LIMIT $2
    `,
    [DEFAULT_WINDOW_HOURS, limit]
  )
  return rows
}

async function backfill() {
  console.log(
    `Starting backfill of Web Discovery articles (window ${DEFAULT_WINDOW_HOURS}h, batch ${BATCH_SIZE})`
  )

  let processed = 0
  let updated = 0
  let skipped = 0

  while (true) {
    const articles = await fetchWebDiscoveryArticles(BATCH_SIZE)
    if (articles.length === 0) break

    for (const article of articles) {
      const host = hostFromUrl(article.canonical_url)
      if (!host || HOST_BLOCKLIST.has(host)) {
        skipped++
        continue
      }

      try {
        const { sourceId, name, homepage } = await getOrCreateSourceForHost(
          host,
          article.publisher_name
        )

        await query(
          `
            UPDATE articles
            SET source_id = $1,
                publisher_name = COALESCE($2, publisher_name),
                publisher_homepage = COALESCE($3, publisher_homepage)
            WHERE id = $4
              AND source_id <> $1
          `,
          [sourceId, name, homepage ?? `https://${host}`, article.id]
        )

        updated++
      } catch (error) {
        console.error(`Failed to update article ${article.id}:`, error)
        skipped++
      }

      processed++
    }

    if (articles.length < BATCH_SIZE) {
      break
    }
  }

  console.log(
    `Backfill complete. Processed=${processed}, Updated=${updated}, Skipped=${skipped}`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfill()
    .then(() => endPool())
    .catch((err) => {
      console.error(err)
      endPool().finally(() => process.exit(1))
    })
}

