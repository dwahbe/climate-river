// scripts/ingest.ts
import Parser from 'rss-parser'
import { createHash } from 'crypto'
import * as DB from '@/lib/db'
import { stripUtm } from '@/lib/text'
import { applySchema } from './schema'
import { removeStopwords } from 'stopword'

type SourceRow = {
  id: number
  name: string
  feed_url: string
  homepage_url?: string | null
  weight: number
}

type FeedSource = {
  name: string
  feed_url: string
  homepage_url?: string
  weight?: number
}

const parser = new Parser({
  timeout: 10000, // ms
  headers: { 'user-agent': 'ClimateRiverBot/0.1 (+https://example.com)' },
})

function sha1(s: string) {
  return createHash('sha1').update(s).digest('hex')
}

function clusterKeyFromTitle(title: string) {
  const base = (title || '')
    .toLowerCase()
    .replace(/[’'“”"]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
  const words = base.split(/\s+/).filter(Boolean)
  const kept = removeStopwords(words)
  const key = kept.slice(0, 8).join('-')
  return key || sha1(base).slice(0, 16)
}

async function upsertSource(s: FeedSource): Promise<number> {
  const { rows } = await DB.query<{ id: number }>(
    `
    insert into sources (name, feed_url, homepage_url, weight)
    values ($1,$2,$3,coalesce($4,1))
    on conflict (feed_url)
    do update set
      name = excluded.name,
      homepage_url = excluded.homepage_url,
      weight = coalesce(excluded.weight, sources.weight)
    returning id
  `,
    [s.name, s.feed_url, s.homepage_url ?? null, s.weight ?? 1]
  )
  return rows[0].id
}

async function ensureSourceRows(sources: FeedSource[]): Promise<SourceRow[]> {
  const out: SourceRow[] = []
  for (const s of sources) {
    const id = await upsertSource(s)
    out.push({
      id,
      name: s.name,
      feed_url: s.feed_url,
      homepage_url: s.homepage_url ?? null,
      weight: s.weight ?? 1,
    })
  }
  return out
}

async function insertArticle(params: {
  source_id: number
  title: string
  url?: string | null
  canonical_url?: string | null
  summary?: string | null
  published_at?: Date | null
}) {
  const { source_id, title } = params
  const canonical = (params.canonical_url || params.url || '').trim()
  const hash = sha1((title || '') + '|' + canonical)

  const { rows } = await DB.query<{ id: number }>(
    `
    insert into articles (source_id, title, url, canonical_url, summary, published_at, hash)
    values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (hash) do nothing
    returning id
  `,
    [
      source_id,
      title,
      params.url ?? null,
      canonical || null,
      params.summary ?? null,
      params.published_at ?? new Date(),
      hash,
    ]
  )

  if (rows[0]?.id) return { id: rows[0].id, created: true }

  // already exists: get id by hash
  const found = await DB.query<{ id: number }>(
    'select id from articles where hash=$1 limit 1',
    [hash]
  )
  return { id: found.rows[0]?.id, created: false }
}

async function ensureClusterFor(title: string) {
  const key = clusterKeyFromTitle(title)
  const { rows } = await DB.query<{ id: number }>(
    `
    insert into clusters (key)
    values ($1)
    on conflict (key) do update set key = excluded.key
    returning id
  `,
    [key]
  )
  return rows[0].id
}

async function linkArticleToCluster(article_id: number, cluster_id: number) {
  await DB.query(
    `
    insert into article_clusters (article_id, cluster_id)
    values ($1,$2)
    on conflict do nothing
  `,
    [article_id, cluster_id]
  )
}

async function fetchSourcesList(): Promise<FeedSource[]> {
  // Prefer the repo list; fallback to two known feeds so ingest always works
  try {
    // Works if tsconfig has "resolveJsonModule": true
    const mod: any = await import('@/data/sources.json')
    const list: FeedSource[] = (mod.default || mod) as any
    if (Array.isArray(list) && list.length) return list
  } catch {}
  return [
    {
      name: 'Carbon Brief',
      feed_url: 'https://www.carbonbrief.org/feed',
      homepage_url: 'https://www.carbonbrief.org',
      weight: 1,
    },
    {
      name: 'Grist',
      feed_url: 'https://grist.org/feed/',
      homepage_url: 'https://grist.org',
      weight: 1,
    },
  ]
}

async function ingestSource(s: SourceRow, maxNew: number) {
  let created = 0
  let linked = 0

  const feed = await parser.parseURL(s.feed_url)
  for (const item of feed.items || []) {
    if (created >= maxNew) break

    const title = (item.title || '').trim()
    if (!title) continue

    const rawUrl = (item.link || item.guid || '').toString()
    const canonical = stripUtm(rawUrl)

    const pub = item.isoDate
      ? new Date(item.isoDate)
      : item.pubDate
      ? new Date(item.pubDate)
      : new Date()
    const summary =
      (item.contentSnippet || item.summary || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000) || null

    const ins = await insertArticle({
      source_id: s.id,
      title,
      url: rawUrl || null,
      canonical_url: canonical || null,
      summary,
      published_at: pub,
    })

    if (!ins.id) continue
    if (ins.created) created++

    const cluster_id = await ensureClusterFor(title)
    await linkArticleToCluster(ins.id, cluster_id)
    linked++
  }

  return { created, linked }
}

export async function run(opts?: { limit?: number }) {
  const t0 = Date.now()
  await applySchema()

  const sources = await fetchSourcesList()
  const rows = await ensureSourceRows(sources)

  // Limit total new items per run (avoid function timeouts). Default ~24.
  const totalBudget = Math.max(1, Math.min(200, opts?.limit ?? 24))
  const perSource = Math.max(
    1,
    Math.floor(totalBudget / Math.max(1, rows.length))
  )

  let created = 0
  let linked = 0

  for (const s of rows) {
    const res = await ingestSource(s, perSource)
    created += res.created
    linked += res.linked
  }

  return {
    ok: true,
    sources: rows.length,
    created,
    linked,
    took_ms: Date.now() - t0,
  }
}

// Keep default export for compatibility with any older imports
export default { run }
