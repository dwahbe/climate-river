import Parser from 'rss-parser'
import dayjs from 'dayjs'
import fs from 'fs'
import stringSimilarity from 'string-similarity'
import { pathToFileURL } from 'url'

import { query } from '../lib/db'
import { normalizeTitleKey, stripUtm } from '../lib/text'
import { tagArticle } from '../lib/tagger'

type Source = { slug: string; name: string; rss: string; weight?: number }

const parser = new Parser({
  timeout: 15000,
  headers: { 'user-agent': 'climate-river-mvp/0.1 (+https://example.com)' },
})

async function ensureSchema() {
  const sql = fs.readFileSync('schema.sql', 'utf8')
  // run statements one-by-one to avoid multi-statement pitfalls
  const statements = sql
    .split(/;\s*\n/g)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const stmt of statements) {
    await query(stmt)
  }
}

async function upsertSources(sources: Source[]) {
  for (const s of sources) {
    await query(
      `insert into sources (slug, name, rss, weight) values ($1,$2,$3,$4)
       on conflict (slug) do update set name=excluded.name, rss=excluded.rss, weight=excluded.weight`,
      [s.slug, s.name, s.rss, s.weight ?? 1.0]
    )
  }
}

async function getOrCreateClusterByTitleKey(key: string): Promise<number> {
  // exact
  const { rows: exact } = await query<{ id: number }>(
    `select id from clusters where key=$1`,
    [key]
  )
  if (exact.length) return exact[0].id

  // fuzzy vs recent
  const { rows: recent } = await query<{ id: number; key: string }>(`
    select id, key from clusters
    where created_at > now() - interval '96 hours'
    order by id desc
    limit 500
  `)
  if (recent.length) {
    const keys = recent.map((r) => r.key)
    const match = stringSimilarity.findBestMatch(key, keys)
    if (match.bestMatch.rating >= 0.86) {
      return recent[match.bestMatchIndex].id
    }
  }

  // new
  const ins = await query<{ id: number }>(
    `insert into clusters (key) values ($1) returning id`,
    [key]
  )
  return ins.rows[0].id
}

async function insertArticle(sourceId: number, item: any) {
  const url = item.link || item.guid
  const title = (item.title || '').trim()
  if (!url || !title) return

  const canonical = stripUtm(url)
  const publishedAt = dayjs(item.isoDate || item.pubDate || new Date()).toDate()
  const author = (item.creator || item.author || '').toString() || null
  const summary =
    (item.contentSnippet || item.content || item.summary || '')
      .toString()
      .trim() || null

  // insert article (skip dupes by canonical_url)
  const ins = await query<{ id: number }>(
    `
    insert into articles (source_id,url,canonical_url,title,author,summary,published_at)
    values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (canonical_url) do nothing
    returning id
  `,
    [sourceId, url, canonical, title, author, summary, publishedAt]
  )
  if (ins.rowCount === 0) return
  const articleId = ins.rows[0].id

  // title-based clustering
  const key = normalizeTitleKey(title)
  const clusterId = await getOrCreateClusterByTitleKey(key)
  await query(
    `insert into article_clusters (cluster_id, article_id) values ($1,$2) on conflict do nothing`,
    [clusterId, articleId]
  )

  // tags
  const tags = tagArticle({ title, summary })
  for (const slug of tags) {
    await query(
      `insert into article_tags (article_id, tag_id)
       select $1, t.id from tags t where t.slug=$2
       on conflict do nothing`,
      [articleId, slug]
    )
  }
}

async function recomputeScores() {
  await query(`delete from cluster_scores`)
  await query(`
    insert into cluster_scores (cluster_id, lead_article_id, size, score, why)
    with items as (
      select ac.cluster_id, a.id as article_id, a.published_at, s.weight
      from article_clusters ac
      join articles a on a.id = ac.article_id
      join sources s on s.id = a.source_id
      where a.published_at > now() - interval '7 days'
    ),
    lead as (
      select cluster_id,
             (array_agg(article_id order by published_at desc))[1] as lead_article_id,
             max(published_at) as lead_time,
             count(*) as size,
             avg(weight) as avg_weight
      from items
      group by cluster_id
    )
    select l.cluster_id, l.lead_article_id, l.size,
           (0.6 * exp(-extract(epoch from (now() - l.lead_time))/28800.0)
            + 0.25 * l.avg_weight
            + 0.15 * ln(1 + l.size)) as score,
           'freshness + avg source weight + size' as why
    from lead l
    order by score desc;
  `)
}

export async function run() {
  await ensureSchema()

  const raw = fs.readFileSync('data/sources.json', 'utf8')
  let sources: Source[] = JSON.parse(raw)

  if (process.env.LIMIT_SOURCES) {
    const allow = new Set(
      process.env.LIMIT_SOURCES.split(',').map((s) => s.trim())
    )
    sources = sources.filter((s) => allow.has(s.slug))
  }

  await upsertSources(sources)

  for (const src of sources) {
    const { rows } = await query<{ id: number }>(
      `select id from sources where slug=$1`,
      [src.slug]
    )
    if (!rows.length) continue
    const sourceId = rows[0].id

    try {
      const feed = await parser.parseURL(src.rss)
      for (const item of feed.items) {
        await insertArticle(sourceId, item)
      }
    } catch (e: any) {
      console.error('Error fetching', src.slug, e?.message || e)
    }
  }

  await recomputeScores()
  console.log('Ingest complete.')
}

// ESM-safe launcher (works with tsx)
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()
if (isMain) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
