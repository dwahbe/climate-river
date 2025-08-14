// scripts/ingest.ts
import Parser from 'rss-parser'
import dayjs from 'dayjs'
import { query, endPool } from '@/lib/db'
import sources from '@/data/sources.json'

/* =========================
   Types
========================= */
type SourceRaw = {
  slug?: string
  name: string
  rss?: string
  feed?: string
  homepage?: string
  weight?: number
}
type SourceDef = {
  name: string
  homepage: string
  feed: string
  weight: number
  slug: string
}
type RssItem = {
  title?: string
  link?: string
  isoDate?: string
  pubDate?: string

  // content
  contentSnippet?: string
  description?: string
  summary?: string
  content?: string
  'content:encoded'?: string
  contentEncoded?: string // we map content:encoded -> contentEncoded

  // authors (many feeds)
  author?: string
  creator?: string
  creators?: string[]
  'dc:creator'?: string
  authors?: Array<{ name?: string }>
}

/* =========================
   Small utilities
========================= */
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
function toOneLiner(raw: string, max = 200) {
  const txt = stripHtml(raw)
  const m = txt.match(/(.{40,}?[\.!\?])\s/) // first sentence-ish if long enough
  const cut = m?.[1] ?? txt
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + '…' : cut
}
function makeDek(it: RssItem) {
  const raw = pick(
    it.contentSnippet,
    it.description,
    it.summary,
    it.content,
    it.contentEncoded
  )
  return raw ? toOneLiner(raw) : ''
}
/** remove tracking params and normalize */
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
/** quick title-derived key for clustering */
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
/** bounded concurrency map */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, idx: number) => Promise<R>
) {
  const ret: R[] = new Array(items.length)
  let i = 0
  let active = 0
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

/* =========================
   Author + Google News helpers
========================= */
function getAuthor(it: RssItem): string | undefined {
  const fromArr = (it.authors && it.authors[0]?.name) || it.creators?.[0]
  const dc = (it as any)['dc:creator']

  const raw = it.author || it.creator || fromArr || dc || undefined

  if (raw) return String(raw).trim()

  const guess = pick(it.contentSnippet, it.description, it.summary)
  const m = guess?.match(/^\s*by\s+([A-Z][^,–—-]+?)(?:\s*[–—-]|,|\.)/i)
  return m ? m[1].trim() : undefined
}
function isGoogleNewsFeed(feedUrl: string) {
  try {
    return new URL(feedUrl).hostname.includes('news.google.com')
  } catch {
    return false
  }
}
function extractHrefs(html?: string): string[] {
  if (!html) return []
  const out: string[] = []
  const re = /href="([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.push(m[1])
  return out
}
/** For Google News items, try to find the original publisher URL from content */
function bestLinkFromGoogleItem(it: RssItem): string | undefined {
  const candidates = [
    ...extractHrefs(it.contentEncoded),
    ...extractHrefs(it.content),
    ...extractHrefs(it.summary),
    ...extractHrefs(it.description),
  ]
  for (const u of candidates) {
    try {
      const host = new URL(u).hostname
      if (!/news\.google\.com$/i.test(host)) return u
    } catch {}
  }
  // occasionally Google includes a `url=` param
  if (it.link && it.link.includes('url=')) {
    try {
      const u = new URL(it.link)
      const urlParam = u.searchParams.get('url')
      if (urlParam) return urlParam
    } catch {}
  }
  return undefined
}

/* =========================
   Source normalization
========================= */
function normalizeSource(s: SourceRaw): SourceDef | null {
  const feed = s.feed ?? s.rss ?? ''
  if (!feed) return null
  const homepage =
    s.homepage ||
    (() => {
      try {
        return new URL(feed).origin
      } catch {
        return ''
      }
    })()
  const slug =
    (s.slug && slugify(s.slug)) ||
    `${slugify(s.name || homepage)}-${shortHash(feed)}`
  return {
    name: s.name,
    homepage,
    feed,
    weight: s.weight ?? 1,
    slug,
  }
}

/* =========================
   Schema
========================= */
async function ensureSchema() {
  // sources
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
       set slug = regexp_replace(
         lower(coalesce(name, homepage_url, feed_url)),
         '[^a-z0-9]+','-','g'
       )
     where slug is null;
  `)
  await query(`create index if not exists idx_sources_slug on sources(slug);`)

  // articles (+ author + dek)
  await query(`
    create table if not exists articles (
      id            bigserial primary key,
      source_id     bigint references sources(id) on delete cascade,
      title         text not null,
      canonical_url text not null unique,
      published_at  timestamptz,
      fetched_at    timestamptz not null default now(),
      dek           text,
      author        text
    );
  `)
  await query(
    `alter table if exists articles add column if not exists dek text;`
  )
  await query(
    `alter table if exists articles add column if not exists author text;`
  )
  await query(`
    create index if not exists idx_articles_published_at
      on articles(published_at desc);
  `)

  // clusters + link
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

/* =========================
   DB helpers
========================= */
async function upsertSources(defs: SourceDef[]) {
  if (!defs.length) return
  const params: any[] = []
  const valuesSql = defs
    .map((r, i) => {
      const o = i * 5
      params.push(r.name, r.homepage, r.feed, r.weight, r.slug)
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`
    })
    .join(', ')
  await query(
    `
      insert into sources (name, homepage_url, feed_url, weight, slug)
      values ${valuesSql}
      on conflict (feed_url) do update set
        name = excluded.name,
        homepage_url = excluded.homepage_url,
        weight = excluded.weight,
        slug = excluded.slug
    `,
    params
  )
}
async function sourceMap(): Promise<Record<string, { id: number }>> {
  const { rows } = await query<{ id: number; feed_url: string }>(
    `select id, feed_url from sources`
  )
  const map: Record<string, { id: number }> = {}
  for (const r of rows) map[r.feed_url] = { id: r.id }
  return map
}
async function insertArticle(
  sourceId: number,
  title: string,
  url: string,
  publishedAt?: string,
  dek?: string,
  author?: string
) {
  const row = await query<{ id: number }>(
    `
    insert into articles (source_id, title, canonical_url, published_at, dek, author)
    values ($1, $2, $3, $4, $5, $6)
    on conflict (canonical_url) do update
      set dek    = coalesce(articles.dek, excluded.dek),
          author = coalesce(articles.author, excluded.author)
    returning id
  `,
    [
      sourceId,
      title,
      url,
      publishedAt ? dayjs(publishedAt).toDate() : null,
      dek || null,
      author || null,
    ]
  )
  return row.rows[0]?.id
}
async function ensureClusterForArticle(articleId: number, title: string) {
  const key = clusterKey(title)
  if (!key) return
  const cluster = await query<{ id: number }>(
    `
    insert into clusters (key)
    values ($1)
    on conflict (key) do update set key = excluded.key
    returning id
  `,
    [key]
  )
  const clusterId = cluster.rows[0].id
  await query(
    `
    insert into article_clusters (article_id, cluster_id)
    values ($1, $2)
    on conflict do nothing
  `,
    [articleId, clusterId]
  )
}

/* =========================
   Ingest a single feed
========================= */
async function ingestFromFeed(feedUrl: string, sourceId: number, limit = 20) {
  const parser = new Parser<RssItem>({
    headers: {
      'User-Agent':
        'ClimateRiverBot/0.1 (+https://climate-news-gules.vercel.app)',
    },
    requestOptions: { timeout: 15000 },
    customFields: {
      item: [['content:encoded', 'contentEncoded']],
    },
  })

  let feed
  try {
    feed = await parser.parseURL(feedUrl)
  } catch (e: any) {
    console.warn(`Feed error for ${feedUrl}: ${e?.message || e}`)
    return { scanned: 0, inserted: 0 }
  }

  const items = (feed.items || []) as RssItem[]
  const slice = items.slice(0, limit)
  const googleFeed = isGoogleNewsFeed(feedUrl)

  let inserted = 0
  for (const it of slice) {
    const rawTitle = (it.title || '').trim()
    const rawLink = (it.link || '').trim()
    if (!rawTitle || !rawLink) continue

    // Prefer original publisher URL for Google News items
    let chosenLink = rawLink
    try {
      const linkHost = new URL(rawLink).hostname
      if (googleFeed || /news\.google\.com$/i.test(linkHost)) {
        const candidate = bestLinkFromGoogleItem(it)
        if (candidate) chosenLink = candidate
      }
    } catch {
      // ignore URL parse failures
    }

    const url = canonical(chosenLink)
    const dek = makeDek(it)
    const author = getAuthor(it)

    const articleId = await insertArticle(
      sourceId,
      rawTitle,
      url,
      it.isoDate || it.pubDate,
      dek,
      author
    )
    if (articleId) {
      inserted++
      await ensureClusterForArticle(articleId, rawTitle)
    }
  }

  return { scanned: slice.length, inserted }
}

/* =========================
   Main entry
========================= */
export async function run(opts: { limit?: number; closePool?: boolean } = {}) {
  const start = Date.now()
  await ensureSchema()

  const defs = (sources as unknown as SourceRaw[])
    .map(normalizeSource)
    .filter((d): d is SourceDef => !!d && !!d.feed)

  await upsertSources(defs)
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

/* =========================
   CLI
========================= */
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err)
    endPool().finally(() => process.exit(1))
  })
}
