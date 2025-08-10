type SourceRaw = {
  name: string
  rss?: string
  feed?: string
  homepage?: string
  weight?: number
  slug?: string
}

/** Convert whatever the JSON has into our canonical SourceDef shape */
function normalizeSource(s: SourceRaw): SourceDef {
  // prefer explicit feed, else rss
  const feed = s.feed ?? s.rss ?? ''
  // best-effort homepage if not provided
  const homepage =
    s.homepage ??
    (() => {
      try {
        return new URL(feed).origin
      } catch {
        return ''
      }
    })()

  return {
    name: s.name,
    homepage,
    feed,
    weight: s.weight,
  }
}

// scripts/ingest.ts
import sources from '@/data/sources.json'
import Parser from 'rss-parser'
import dayjs from 'dayjs'
import { query, pool } from '@/lib/db'

type SourceDef = {
  name: string
  homepage: string
  feed: string
  weight?: number
}

type RssItem = {
  title?: string
  link?: string
  isoDate?: string
  pubDate?: string
}

/* ---------------------------------- */
/* Helpers                            */
/* ---------------------------------- */

function slugify(input: string) {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80)
}

/** remove common tracking params and normalize */
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

/** tiny clustering key derived from the title (no external deps) */
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

/* ---------------------------------- */
/* Minimal, idempotent schema guard   */
/* ---------------------------------- */
async function ensureSchema() {
  // sources
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int not null default 1,
      slug          text
    );
  `)

  // ensure slug column exists (defensive) then backfill
  await query(
    `alter table if exists sources add column if not exists slug text;`
  )
  await query(`
    update sources
       set slug = regexp_replace(
         lower(coalesce(name, homepage_url, feed_url)),
         '[^a-z0-9]+', '-', 'g'
       )
     where slug is null;
  `)

  // now enforce constraints / indexes
  await query(`alter table if exists sources alter column slug set not null;`)
  await query(
    `create unique index if not exists idx_sources_slug on sources(slug);`
  )

  // articles
  await query(`
    create table if not exists articles (
      id            bigserial primary key,
      source_id     bigint references sources(id) on delete cascade,
      title         text not null,
      canonical_url text not null unique,
      published_at  timestamptz,
      fetched_at    timestamptz not null default now()
    );
  `)
  await query(
    `create index if not exists idx_articles_published_at on articles(published_at desc);`
  )

  // clusters
  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `)

  // linking table
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `)
}

/* ---------------------------------- */
/* Ingest helpers                      */
/* ---------------------------------- */
async function upsertSources(defs: SourceDef[]) {
  if (!defs.length) return

  const rows = defs.map((s) => {
    const fallbackHost = (() => {
      try {
        return new URL(s.homepage).hostname
      } catch {
        /* noop */
      }
      try {
        return new URL(s.feed).hostname
      } catch {
        return s.feed
      }
    })()
    const slug = slugify(s.name || fallbackHost) || slugify(s.feed)

    return {
      name: s.name,
      homepage_url: s.homepage,
      feed_url: s.feed,
      weight: s.weight ?? 1,
      slug,
    }
  })

  const params: any[] = []
  const valuesSql = rows
    .map((r, i) => {
      const o = i * 5
      params.push(r.name, r.homepage_url, r.feed_url, r.weight, r.slug)
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

async function ingestFromFeed(feedUrl: string, sourceId: number, limit = 20) {
  const parser = new Parser({
    headers: {
      'User-Agent':
        'ClimateRiverBot/0.1 (+https://climate-news-gules.vercel.app)',
    },
    requestOptions: { timeout: 15000 },
  })

  let feed
  try {
    feed = await parser.parseURL(feedUrl)
  } catch (e: any) {
    console.warn(`Feed error for ${feedUrl}: ${e?.message || e}`)
    return 0
  }

  const items = (feed.items || []) as RssItem[]
  let inserted = 0

  for (const it of items.slice(0, limit)) {
    const title = (it.title || '').trim()
    const link = (it.link || '').trim()
    if (!title || !link) continue

    const url = canonical(link)
    const articleId = await insertArticle(
      sourceId,
      title,
      url,
      it.isoDate || it.pubDate
    )
    if (articleId) {
      inserted++
      await ensureClusterForArticle(articleId, title)
    }
  }
  return inserted
}

/* ---------------------------------- */
/* Main (exported)                     */
/* ---------------------------------- */
export async function run() {
  const start = Date.now()
  await ensureSchema()

  const defs = (sources as SourceRaw[])
    .map(normalizeSource)
    .filter((d) => d.feed) // guard against any missing feed/rss entries

  await upsertSources(defs)
  const idByFeed = await sourceMap()

  const results = await mapLimit(defs, 4, async (s) => {
    try {
      const sid = idByFeed[s.feed]?.id
      if (!sid) return { name: s.name, inserted: 0, error: 'source id missing' }
      const inserted = await ingestFromFeed(s.feed, sid, 25)
      return { name: s.name, inserted }
    } catch (e: any) {
      return { name: s.name, inserted: 0, error: e?.message || String(e) }
    }
  })

  const total = results.reduce((sum, r) => sum + r.inserted, 0)
  console.log('Ingest results:', results)
  console.log(
    `Done. Inserted ${total} articles in ${Math.round(
      (Date.now() - start) / 1000
    )}s.`
  )

  await pool.end()
  return { total, results }
}

/* Allow `npm run ingest` to work too */
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
