// scripts/discover.ts
import Parser from 'rss-parser'
import dayjs from 'dayjs'
import { query, endPool } from '@/lib/db'

type SourceDef = {
  name: string
  homepage_url: string
  feed_url: string // we use a stable pseudo value like discover://host
  weight?: number
  slug: string
}

type RssItem = {
  title?: string
  link?: string
  isoDate?: string
  pubDate?: string
}

// ------- config -------
const DEFAULT_QUERIES = [
  'climate change',
  'global warming',
  'carbon emissions',
  'renewable energy',
  'solar power',
  'wind power',
  'carbon capture',
  'EV sales',
  'heat wave',
  'wildfire',
  'flooding',
  'drought',
  'sea level rise',
  'IPCC',
]

// locale / edition for Google News (defaults to US-English)
const GN_HL = process.env.DISCOVER_HL || 'en-US'
const GN_GL = process.env.DISCOVER_GL || 'US'
const GN_CEID = process.env.DISCOVER_CEID || 'US:en'

// ------- utils -------
function slugify(input: string) {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80)
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
  const t = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
  const words = t.split(/\s+/).filter(Boolean)
  const SKIP = new Set([
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
  const kept = words.filter((w) => !SKIP.has(w) && w.length >= 3)
  return kept.slice(0, 8).join('-')
}

/** Google News sometimes links to news.google.com/... with a ?url= param. Extract it if present. */
function resolveGoogleNewsLink(link: string) {
  try {
    const u = new URL(link)
    if (u.hostname.endsWith('news.google.com')) {
      const real = u.searchParams.get('url')
      if (real) return real
    }
  } catch {}
  return link
}

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

// ------- minimal schema guards (safe if already run elsewhere) -------
async function ensureSchema() {
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int not null default 1,
      slug          text not null
    );
  `)
  await query(`
    create table if not exists articles (
      id            bigserial primary key,
      source_id     bigint references sources(id) on delete cascade,
      title         text not null,
      canonical_url text not null unique,
      published_at  timestamptz,
      fetched_at    timestamptz not null default now(),
      dek           text,
      rewritten_title text,
      rewritten_at  timestamptz,
      rewrite_model text,
      rewrite_notes text
    );
  `)
  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `)
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `)
}

// ------- DB helpers -------
async function upsertSourceForHost(host: string) {
  const name = host.replace(/^www\./, '')
  const homepage = `https://${name}`
  const slug = slugify(name)
  const feed = `discover://${name}` // stable pseudo-URL to satisfy NOT NULL + uniqueness

  const { rows } = await query<{ id: number }>(
    `
      insert into sources (name, homepage_url, feed_url, weight, slug)
      values ($1, $2, $3, 1, $4)
      on conflict (feed_url) do update set
        name = excluded.name,
        homepage_url = excluded.homepage_url,
        slug = excluded.slug
      returning id
    `,
    [name, homepage, feed, slug]
  )
  return rows[0].id
}

async function insertArticle(
  sourceId: number,
  title: string,
  url: string,
  publishedAt?: string
) {
  const row = await query<{ id: number }>(
    `
    insert into articles (source_id, title, canonical_url, published_at)
    values ($1, $2, $3, $4)
    on conflict (canonical_url) do nothing
    returning id
  `,
    [sourceId, title, url, publishedAt ? dayjs(publishedAt).toDate() : null]
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
  await query(
    `
    insert into article_clusters (article_id, cluster_id)
    values ($1, $2)
    on conflict do nothing
  `,
    [articleId, cluster.rows[0].id]
  )
}

// ------- main work -------
function googleNewsUrl(q: string) {
  const base = 'https://news.google.com/rss/search'
  const qs = new URLSearchParams({
    q,
    hl: GN_HL,
    gl: GN_GL,
    ceid: GN_CEID,
  })
  return `${base}?${qs.toString()}`
}

async function ingestQuery(q: string, limitPerQuery = 25) {
  const parser = new Parser({
    headers: {
      // polite but browsery UA; helps some endpoints
      'User-Agent':
        'Mozilla/5.0 (compatible; ClimateRiverBot/0.1; +https://climate-news-gules.vercel.app)',
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
    requestOptions: { timeout: 20000 },
  })
  const url = googleNewsUrl(q)
  let feed
  try {
    feed = await parser.parseURL(url)
  } catch (e: any) {
    console.warn(`Discover feed error for "${q}": ${e?.message || e}`)
    return { scanned: 0, inserted: 0 }
  }

  const items = (feed.items || []) as RssItem[]
  let inserted = 0
  let scanned = 0

  for (const it of items.slice(0, limitPerQuery)) {
    scanned++
    const title = (it.title || '').trim()
    const raw = (it.link || '').trim()
    if (!title || !raw) continue

    const resolved = resolveGoogleNewsLink(raw)
    const urlCanon = canonical(resolved)

    let host = ''
    try {
      host = new URL(urlCanon).hostname
    } catch {
      continue
    }
    const sid = await upsertSourceForHost(host)
    const id = await insertArticle(
      sid,
      title,
      urlCanon,
      it.isoDate || it.pubDate
    )
    if (id) {
      inserted++
      await ensureClusterForArticle(id, title)
    }
  }

  return { scanned, inserted }
}

export async function run(
  opts: { queries?: string[]; limitPerQuery?: number; closePool?: boolean } = {}
) {
  await ensureSchema()

  const queries = process.env.DISCOVER_QUERIES
    ? process.env.DISCOVER_QUERIES.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_QUERIES

  const limitPerQuery = Math.max(5, Math.min(50, opts.limitPerQuery ?? 20))

  const results = await mapLimit(queries, 4, (q) =>
    ingestQuery(q, limitPerQuery)
  )
  const scanned = results.reduce((a, b) => a + b.scanned, 0)
  const inserted = results.reduce((a, b) => a + b.inserted, 0)

  if (opts.closePool) await endPool()
  return { queries: queries.length, scanned, inserted }
}

// CLI: npx tsx scripts/discover.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true })
    .then((r) => {
      console.log('Discover results:', r)
      process.exit(0)
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
