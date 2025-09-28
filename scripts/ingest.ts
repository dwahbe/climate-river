// scripts/ingest.ts
import Parser from 'rss-parser'
import dayjs from 'dayjs'
import { query, endPool } from '@/lib/db'
import { categorizeAndStoreArticle } from '@/lib/categorizer'
import OpenAI from 'openai'

// Initialize OpenAI client for embeddings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// ---------- Parser configured once (captures <source>, rich content) ----------
type RssItem = {
  title?: string
  link?: string
  isoDate?: string
  pubDate?: string
  description?: string
  content?: string
  contentSnippet?: string
  summary?: string
  // customFields we map in:
  contentEncoded?: string
  source?: any
  creator?: string
  author?: string
}

const parser = new Parser<RssItem>({
  headers: {
    'User-Agent': 'ClimateRiverBot/0.1 (+https://climateriver.org)',
  },
  requestOptions: { timeout: 20000 },
  customFields: {
    item: [
      // Publisher embedded by Google News: <source url="...">Publisher</source>
      ['source', 'source', { keepArray: true }],
      // Rich content
      ['content:encoded', 'contentEncoded'],
      // Common fields
      'content',
      'contentSnippet',
      'summary',
      // Authors
      ['dc:creator', 'creator'],
      'author',
    ],
  },
})

// ---------- Helpers ----------
function isGoogleNewsFeed(feedUrl: string) {
  try {
    return new URL(feedUrl).hostname.includes('news.google.com')
  } catch {
    return false
  }
}

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

/** Unwrap Google News redirect to publisher URL when present */
function unGoogleLink(link: string) {
  try {
    const u = new URL(link)
    if (u.hostname.includes('news.google.com')) {
      const direct = u.searchParams.get('url')
      if (direct) return direct
    }
    return link
  } catch {
    return link
  }
}

function extractPublisherFromGoogleItem(item: RssItem): {
  name?: string
  homepage?: string
} {
  const src = (item as any)?.source
  // rss-parser usually shapes <source> as { _: 'Publisher', $: { url: '...' } }
  const first = Array.isArray(src) ? src[0] : src
  if (first) {
    const name =
      (typeof first === 'string'
        ? first
        : (first['#'] ?? first._ ?? first.text ?? first.value)) || undefined
    const homepage =
      (typeof first === 'object' && (first.$?.url ?? first.url)) || undefined
    if (name || homepage) return { name: String(name).trim(), homepage }
  }

  // Fallback: title suffix like "Title — Publisher"
  if (item.title) {
    const m = item.title.match(/\s[-—]\s([^]+)$/)
    if (m) {
      const name = m[1].trim()
      const homepage = /\b[a-z0-9.-]+\.[a-z]{2,}\b/i.test(name)
        ? `https://${name}`
        : undefined
      return { name, homepage }
    }
  }
  return {}
}

function cleanGoogleNewsTitle(title: string) {
  return title.replace(/\s[-—]\s[^-—]+$/, '').trim()
}

function stripHtml(s: string) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function pick(...vals: Array<string | undefined | null>) {
  for (const v of vals) if (v && v.trim()) return v
  return ''
}
function oneLine(raw: string, max = 200) {
  const txt = stripHtml(raw)
  const m = txt.match(/(.{40,}?[\.!\?])\s/) // first sentence-ish if long enough
  const cut = m?.[1] ?? txt
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + '…' : cut
}
function bestDek(it: RssItem) {
  const raw = pick(
    it.contentSnippet,
    it.summary,
    it.description,
    it.content,
    it.contentEncoded
  )
  return raw ? oneLine(raw) : null
}

// Removed SourceRaw type - no longer needed since we fetch from database
type SourceDef = {
  name: string
  homepage: string
  feed: string
  weight: number
  slug: string
}

function slugify(input: string) {
  return (input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64)
}
function shortHash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}
function canonical(url: string) {
  try {
    const u = new URL(url)
    ;[...u.searchParams.keys()].forEach((k) => {
      if (/^utm_|^fbclid$|^gclid$|^mc_/i.test(k)) u.searchParams.delete(k)
    })
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}
function clusterKey(title: string) {
  const t = (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
  const words = t.split(/\s+/).filter(Boolean)
  const STOP = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'to',
    'of',
    'in',
    'on',
    'for',
    'with',
    'by',
    'from',
    'at',
    'is',
    'are',
    'was',
    'were',
    'be',
    'as',
  ])
  const kept = words.filter((w) => !STOP.has(w) && w.length >= 3)
  return kept.slice(0, 8).join('-')
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, idx: number) => Promise<R>
) {
  const ret: R[] = new Array(items.length)
  let i = 0,
    active = 0
  return new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(ret)
      while (active < limit && i < items.length) {
        const cur = i++
        active++
        fn(items[cur], cur)
          .then((v) => (ret[cur] = v))
          .catch(reject)
          .finally(() => {
            active--
            next()
          })
      }
    }
    next()
  })
}

// Removed normalizeSource function - no longer needed since we fetch from database

// ---------- Idempotent schema guard ----------
async function ensureSchema() {
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int  not null default 1,
      slug          text
    );
  `)
  await query(
    `alter table if exists sources add column if not exists slug text;`
  )
  await query(`
    update sources
       set slug = regexp_replace(lower(coalesce(name, homepage_url, feed_url)),'[^a-z0-9]+','-','g')
     where slug is null;
  `)
  await query(`create index if not exists idx_sources_slug on sources(slug);`)

  await query(`
    create table if not exists articles (
      id                 bigserial primary key,
      source_id          bigint references sources(id) on delete cascade,
      title              text not null,
      canonical_url      text not null unique,
      published_at       timestamptz,
      fetched_at         timestamptz not null default now(),
      dek                text,
      author             text,
      publisher_name     text,
      publisher_homepage text
    );
  `)
  await query(
    `alter table if exists articles add column if not exists dek text;`
  )
  await query(
    `alter table if exists articles add column if not exists author text;`
  )
  await query(
    `alter table if exists articles add column if not exists publisher_name text;`
  )
  await query(
    `alter table if exists articles add column if not exists publisher_homepage text;`
  )
  await query(
    `create index if not exists idx_articles_published_at on articles(published_at desc);`
  )

  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `)
  await query(
    `create unique index if not exists idx_clusters_key on clusters(key);`
  )
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `)
}

// ---------- DB helpers ----------
// Removed upsertSources function - sources are now managed directly in database

async function sourceMap(): Promise<Record<string, { id: number }>> {
  const { rows } = await query<{ id: number; feed_url: string }>(
    `select id, feed_url from sources`
  )
  const map: Record<string, { id: number }> = {}
  for (const r of rows) map[r.feed_url] = { id: r.id }
  return map
}

// ---------- Fetch sources from database ----------
async function fetchSourcesFromDB(): Promise<SourceDef[]> {
  const { rows } = await query<{
    id: number
    name: string
    homepage_url: string | null
    feed_url: string
    weight: number
    slug: string
  }>(`
    SELECT id, name, homepage_url, feed_url, weight, slug 
    FROM sources 
    WHERE feed_url IS NOT NULL 
    ORDER BY weight DESC, name
  `)

  return rows.map((row) => ({
    name: row.name,
    homepage: row.homepage_url || '',
    feed: row.feed_url,
    weight: row.weight,
    slug: row.slug,
  }))
}

function parseDateMaybe(s?: string) {
  if (!s) return null
  const d = dayjs(s)
  return d.isValid() ? d.toDate() : null
}

async function insertArticle(
  sourceId: number,
  title: string,
  url: string,
  publishedAt?: string,
  dek?: string | null,
  author?: string | null,
  // defaulted param must NOT be optional
  pub: { name?: string; homepage?: string } = {}
) {
  // ENHANCED DEDUPLICATION: Check for existing articles with same/similar title
  const titleCheck = await query<{ id: number; canonical_url: string }>(
    `SELECT id, canonical_url FROM articles 
     WHERE title = $1 
       AND fetched_at >= now() - interval '7 days'
     LIMIT 1`,
    [title]
  )

  if (titleCheck.rows.length > 0) {
    console.log(
      `⚠️  Duplicate title detected: "${title.substring(0, 50)}..." - skipping (existing ID: ${titleCheck.rows[0].id})`
    )
    return titleCheck.rows[0].id // Return existing article ID
  }

  // Generate embedding for the article
  const embedding = await generateEmbedding(title, dek ?? undefined)

  const row = await query<{ id: number }>(
    `
    insert into articles
      (source_id, title, canonical_url, published_at, dek, author, publisher_name, publisher_homepage, embedding)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (canonical_url) do update set
      dek                 = coalesce(articles.dek, excluded.dek),
      author              = coalesce(articles.author, excluded.author),
      publisher_name      = coalesce(articles.publisher_name, excluded.publisher_name),
      publisher_homepage  = coalesce(articles.publisher_homepage, excluded.publisher_homepage),
      embedding           = coalesce(articles.embedding, excluded.embedding)
    returning id
  `,
    [
      sourceId,
      title,
      url,
      parseDateMaybe(publishedAt),
      dek ?? null,
      author ?? null,
      pub.name ?? null,
      pub.homepage ?? null,
      embedding.length > 0 ? JSON.stringify(embedding) : null,
    ]
  )
  return row.rows[0]?.id
}

async function ensureClusterForArticle(articleId: number, title: string) {
  const key = clusterKey(title)
  if (!key) return

  // CRITICAL FIX: Check if this article is already in ANY cluster
  const articleAlreadyClustered = await query<{ cluster_id: number }>(
    `SELECT cluster_id FROM article_clusters WHERE article_id = $1`,
    [articleId]
  )

  if (articleAlreadyClustered.rows.length > 0) {
    // Article already has a cluster - don't add it to another one
    console.log(
      `Article ${articleId} already in cluster ${articleAlreadyClustered.rows[0].cluster_id}, skipping`
    )
    return
  }

  // Check for exact key match first
  const exactCluster = await query<{ cluster_id: number }>(
    `SELECT ac.cluster_id 
     FROM article_clusters ac 
     JOIN clusters c ON ac.cluster_id = c.id 
     WHERE c.key = $1`,
    [key]
  )

  if (exactCluster.rows.length > 0) {
    // Use existing exact match cluster
    await query(
      `insert into article_clusters (article_id, cluster_id)
       values ($1,$2) on conflict do nothing`,
      [articleId, exactCluster.rows[0].cluster_id]
    )
    return
  }

  // If no exact match, check for similar clusters using weighted similarity
  const keyWords = key.split('-')
  if (keyWords.length >= 3) {
    // Define common/generic words that shouldn't drive clustering
    const genericWords = new Set([
      'climate',
      'energy',
      'environmental',
      'green',
      'carbon',
      'emissions',
      'global',
      'warming',
      'change',
      'crisis',
      'policy',
      'new',
      'latest',
      'report',
      'study',
      'research',
      'data',
      'government',
      'plan',
      'program',
      'project',
      'company',
      'companies',
      'industry',
      'market',
      'business',
      'world',
      'year',
      'years',
      'million',
      'billion',
      'percent',
      'says',
      'will',
      'could',
      'may',
      'might',
      'now',
      'after',
      'before',
      'during',
    ])

    const similarClusters = await query<{ cluster_id: number; key: string }>(
      `SELECT ac.cluster_id, c.key
       FROM article_clusters ac 
       JOIN clusters c ON ac.cluster_id = c.id 
       WHERE c.created_at >= now() - interval '7 days'
       GROUP BY ac.cluster_id, c.key`,
      []
    )

    for (const cluster of similarClusters.rows) {
      const clusterWords = cluster.key.split('-')
      const sharedWords = keyWords.filter((word) => clusterWords.includes(word))

      // Calculate weighted similarity score
      let similarityScore = 0
      let specificMatches = 0

      for (const word of sharedWords) {
        if (genericWords.has(word)) {
          similarityScore += 0.5 // Low weight for generic words
        } else {
          similarityScore += 2.0 // High weight for specific words
          specificMatches++
        }
      }

      // Require: At least 2 specific (non-generic) words + total score >= 4.0
      // This prevents clustering on generic terms like "climate crisis policy"
      if (specificMatches >= 2 && similarityScore >= 4.0) {
        console.log(
          `Article ${articleId} matched cluster ${cluster.cluster_id} with score ${similarityScore.toFixed(1)} (${specificMatches} specific): ${sharedWords.join(', ')}`
        )
        await query(
          `insert into article_clusters (article_id, cluster_id)
           values ($1,$2) on conflict do nothing`,
          [articleId, cluster.cluster_id]
        )
        return
      }
    }
  }

  // No similar cluster found, create new cluster
  const cluster = await query<{ id: number }>(
    `insert into clusters (key) values ($1)
     on conflict (key) do update set key = excluded.key
     returning id`,
    [key]
  )

  // Add article to cluster
  await query(
    `insert into article_clusters (article_id, cluster_id)
     values ($1,$2) on conflict do nothing`,
    [articleId, cluster.rows[0].id]
  )
}

// Update cluster scores when new articles are added
async function updateClusterScore(clusterId: number) {
  try {
    // Simplified cluster scoring - just update lead article and size
    await query(
      `
      INSERT INTO cluster_scores (cluster_id, lead_article_id, size, score)
      SELECT 
        $1 as cluster_id,
        (SELECT a.id 
         FROM articles a
         JOIN article_clusters ac ON ac.article_id = a.id
         WHERE ac.cluster_id = $1
         ORDER BY a.published_at DESC, a.id DESC
         LIMIT 1) as lead_article_id,
        (SELECT COUNT(*) 
         FROM article_clusters 
         WHERE cluster_id = $1) as size,
        EXTRACT(EPOCH FROM NOW()) as score  -- Simple timestamp score
      ON CONFLICT (cluster_id) DO UPDATE SET
        lead_article_id = (SELECT a.id 
                          FROM articles a
                          JOIN article_clusters ac ON ac.article_id = a.id
                          WHERE ac.cluster_id = $1
                          ORDER BY a.published_at DESC, a.id DESC
                          LIMIT 1),
        size = (SELECT COUNT(*) 
                FROM article_clusters 
                WHERE cluster_id = $1),
        updated_at = NOW()
    `,
      [clusterId]
    )
  } catch (error) {
    console.error(
      `Failed to update cluster score for cluster ${clusterId}:`,
      error
    )
    // Don't fail the whole process if scoring fails
  }
}

// New semantic clustering function using vector embeddings
async function ensureSemanticClusterForArticle(
  articleId: number,
  title: string
) {
  // Check if this article is already in ANY cluster
  const articleAlreadyClustered = await query<{ cluster_id: number }>(
    `SELECT cluster_id FROM article_clusters WHERE article_id = $1`,
    [articleId]
  )

  if (articleAlreadyClustered.rows.length > 0) {
    console.log(
      `Article ${articleId} already in cluster ${articleAlreadyClustered.rows[0].cluster_id}, skipping`
    )
    return
  }

  // Get the article's embedding
  const articleResult = await query<{ embedding: string }>(
    `SELECT embedding FROM articles WHERE id = $1 AND embedding IS NOT NULL`,
    [articleId]
  )

  if (articleResult.rows.length === 0) {
    console.log(`Article ${articleId} has no embedding, skipping clustering`)
    return
  }

  const articleEmbedding = articleResult.rows[0].embedding

  // Find similar articles using cosine similarity
  const similarArticles = await query<{
    article_id: number
    cluster_id: number | null
    similarity: number
    title: string
  }>(
    `SELECT 
       a.id as article_id,
       ac.cluster_id,
       1 - (a.embedding <=> $1::vector) as similarity,
       a.title
     FROM articles a
     LEFT JOIN article_clusters ac ON a.id = ac.article_id
                          WHERE a.id != $2
                       AND a.embedding IS NOT NULL
                       AND a.fetched_at >= now() - interval '7 days'
                       AND 1 - (a.embedding <=> $1::vector) > 0.6
     ORDER BY a.embedding <=> $1::vector
     LIMIT 10`,
    [articleEmbedding, articleId]
  )

  // Look for existing clusters among similar articles
  // Find all unique clusters and their best similarity scores
  const clusterCandidates = new Map<
    number,
    {
      similarity: number
      article_id: number
      title: string
    }
  >()

  for (const similar of similarArticles.rows) {
    if (similar.cluster_id) {
      const existing = clusterCandidates.get(similar.cluster_id)
      if (!existing || similar.similarity > existing.similarity) {
        clusterCandidates.set(similar.cluster_id, {
          similarity: similar.similarity,
          article_id: similar.article_id,
          title: similar.title,
        })
      }
    }
  }

  // If we found cluster candidates, join the one with highest similarity
  if (clusterCandidates.size > 0) {
    const bestCluster = Array.from(clusterCandidates.entries()).sort(
      ([, a], [, b]) => b.similarity - a.similarity
    )[0]

    const [clusterId, bestMatch] = bestCluster

    console.log(
      `Article ${articleId} matched existing cluster ${clusterId} via similar article ${bestMatch.article_id} (similarity: ${bestMatch.similarity.toFixed(3)}) - "${bestMatch.title}"`
    )

    // Add this article to the best matching cluster
    await query(
      `INSERT INTO article_clusters (article_id, cluster_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [articleId, clusterId]
    )

    // Update cluster_scores to potentially select a better lead article
    await updateClusterScore(clusterId)
    return
  }

  // If we have similar articles but no existing cluster, create a new one
  if (similarArticles.rows.length > 0) {
    const key = clusterKey(title) || `semantic-${Date.now()}`

    const cluster = await query<{ id: number }>(
      `INSERT INTO clusters (key) VALUES ($1)
       ON CONFLICT (key) DO UPDATE SET key = excluded.key
       RETURNING id`,
      [key]
    )

    const clusterId = cluster.rows[0].id

    // Add the current article to the new cluster
    await query(
      `INSERT INTO article_clusters (article_id, cluster_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [articleId, clusterId]
    )

    // Add all similar articles to the new cluster
    for (const similar of similarArticles.rows) {
      await query(
        `INSERT INTO article_clusters (article_id, cluster_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [similar.article_id, clusterId]
      )
    }

    console.log(
      `Created new semantic cluster ${clusterId} with ${similarArticles.rows.length + 1} articles`
    )

    // Initialize cluster_scores for the new cluster
    await updateClusterScore(clusterId)
    return
  }

  // No similar articles found - article remains unclustered
  console.log(
    `Article ${articleId} - no similar articles found, remains unclustered`
  )
}

// ---------- Ingest one feed ----------
async function ingestFromFeed(feedUrl: string, sourceId: number, limit = 20) {
  let feed
  try {
    feed = await parser.parseURL(feedUrl)
  } catch (e: any) {
    console.warn(`Feed error for ${feedUrl}: ${e?.message || e}`)
    return { scanned: 0, inserted: 0 }
  }

  const items = (feed.items || []) as RssItem[]
  const slice = items.slice(0, limit)

  const fromGoogle = isGoogleNewsFeed(feedUrl)
  let inserted = 0

  for (const it of slice) {
    let title = (it.title || '').trim()
    let link = (it.link || '').trim()
    if (!title || !link) continue

    // Unwrap Google wrapper → real publisher URL when available
    if (fromGoogle) link = unGoogleLink(link)

    const dek = bestDek(it)
    const author = (it.creator || it.author || null) as string | null

    let pub: { name?: string; homepage?: string } = {}
    if (fromGoogle) {
      pub = extractPublisherFromGoogleItem(it)
      if (pub.name) {
        // Clean trailing " - Publisher" now that we store publisher separately
        title = cleanGoogleNewsTitle(title)
      }
    }

    const url = canonical(link)
    const articleId = await insertArticle(
      sourceId,
      title,
      url,
      it.isoDate || it.pubDate,
      dek,
      author,
      pub
    )
    if (articleId) {
      inserted++
      // Use semantic clustering instead of keyword-based clustering
      await ensureSemanticClusterForArticle(articleId, title)

      // Categorize the article using hybrid approach
      try {
        await categorizeAndStoreArticle(articleId, title, dek || undefined)
        console.log(`  📝 Categorized article: ${title.slice(0, 50)}...`)
      } catch (error) {
        console.error(`  ❌ Failed to categorize article ${articleId}:`, error)
        // Don't fail the whole ingestion if categorization fails
      }
    }
  }

  return { scanned: slice.length, inserted }
}

// ---------- Main (export) ----------
export async function run(opts: { limit?: number; closePool?: boolean } = {}) {
  const start = Date.now()
  await ensureSchema()

  // Fetch sources from database instead of JSON file
  const defs = await fetchSourcesFromDB()

  if (defs.length === 0) {
    console.log(
      '⚠️  No sources found in database. Make sure sources are properly configured.'
    )
    if (opts.closePool) await endPool()
    return { total: 0, results: [] }
  }

  const idByFeed = await sourceMap()

  const perFeedLimit = opts.limit ?? 25
  const results = await mapLimit(defs, 4, async (s) => {
    try {
      const sid = idByFeed[s.feed]?.id
      if (!sid)
        return {
          name: s.name,
          scanned: 0,
          inserted: 0,
          error: 'source id missing',
        }
      const { scanned, inserted } = await ingestFromFeed(
        s.feed,
        sid,
        perFeedLimit
      )
      return { name: s.name, scanned, inserted }
    } catch (e: any) {
      return {
        name: s.name,
        scanned: 0,
        inserted: 0,
        error: e?.message || String(e),
      }
    }
  })

  const total = results.reduce((sum, r: any) => sum + (r.inserted || 0), 0)
  console.log('Ingest results:', results)
  console.log(
    `Done. Inserted ${total} in ${Math.round((Date.now() - start) / 1000)}s.`
  )

  if (opts.closePool) await endPool()
  return { total, results }
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true })
    .then(() => {
      console.log('✅ Ingest completed successfully')
      process.exit(0)
    })
    .catch((err) => {
      console.error('❌ Ingest failed:', err)
      endPool().finally(() => process.exit(1))
    })
}
