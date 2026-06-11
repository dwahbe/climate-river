// scripts/ingest.ts
import Parser from "rss-parser";
import dayjs from "dayjs";
import { query, endPool } from "@/lib/db";
import { categorizeAndStoreArticle } from "@/lib/categorizer";
import { isClimateRelevant } from "@/lib/tagger";
import { generateEmbedding, assignArticleToCluster } from "@/lib/clustering";
import {
  classifyArticleLanguageForIngest,
  type LanguageDetection,
} from "@/lib/language";
import { findRecentDuplicate } from "@/lib/articleDedupe";
import {
  canonical,
  mapLimit,
  cleanGoogleNewsTitle,
  isValidArticleDate,
  decodeHtmlEntities,
  extractPublisherFromRssItem,
  type RssSourceField,
} from "@/lib/utils";

// ---------- Parser configured once (captures <source>, rich content) ----------

type RssItem = {
  title?: string;
  link?: string;
  isoDate?: string;
  pubDate?: string;
  description?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  // customFields we map in:
  contentEncoded?: string;
  source?: RssSourceField | RssSourceField[];
  creator?: string;
  author?: string;
};

const parser = new Parser<RssItem>({
  headers: {
    "User-Agent": "ClimateRiverBot/0.1 (+https://climateriver.org)",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
  requestOptions: { timeout: 20000 },
  customFields: {
    item: [
      // Publisher embedded by Google News: <source url="...">Publisher</source>
      ["source", "source", { keepArray: true }],
      // Rich content
      ["content:encoded", "contentEncoded"],
      // Common fields
      "content",
      "contentSnippet",
      "summary",
      // Authors
      ["dc:creator", "creator"],
      "author",
    ],
  },
});

// ---------- Helpers ----------
function isGoogleNewsFeed(feedUrl: string) {
  try {
    return new URL(feedUrl).hostname.includes("news.google.com");
  } catch {
    return false;
  }
}

// generateEmbedding is imported from lib/clustering.ts

/** Unwrap Google News redirect to publisher URL when present */
function unGoogleLink(link: string) {
  try {
    const u = new URL(link);
    if (u.hostname.includes("news.google.com")) {
      const direct = u.searchParams.get("url");
      if (direct) return direct;
    }
    return link;
  } catch {
    return link;
  }
}

const extractPublisherFromGoogleItem = extractPublisherFromRssItem;

function stripHtml(s: string) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(...vals: Array<string | undefined | null>) {
  for (const v of vals) if (v && v.trim()) return v;
  return "";
}
function oneLine(raw: string, max = 300) {
  const txt = stripHtml(raw);
  const m = txt.match(/(.{40,}?[.!?])\s/); // first sentence-ish if long enough
  const cut = m?.[1] ?? txt;
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + "…" : cut;
}
function bestDek(it: RssItem) {
  const raw = pick(
    it.contentSnippet,
    it.summary,
    it.description,
    it.content,
    it.contentEncoded,
  );
  return raw ? oneLine(raw) : null;
}

// Removed SourceRaw type - no longer needed since we fetch from database
type SourceDef = {
  name: string;
  homepage: string;
  feed: string;
  weight: number;
  slug: string;
};
// ---------- Idempotent schema guard ----------
async function ensureSchema() {
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int  not null default 2,
      slug          text
    );
  `);
  await query(
    `alter table if exists sources add column if not exists slug text;`,
  );
  await query(`
    update sources
       set slug = regexp_replace(lower(coalesce(name, homepage_url, feed_url)),'[^a-z0-9]+','-','g')
     where slug is null;
  `);
  await query(`create index if not exists idx_sources_slug on sources(slug);`);

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
  `);
  await query(
    `alter table if exists articles add column if not exists dek text;`,
  );
  await query(
    `alter table if exists articles add column if not exists author text;`,
  );
  await query(
    `alter table if exists articles add column if not exists publisher_name text;`,
  );
  await query(
    `alter table if exists articles add column if not exists publisher_homepage text;`,
  );
  await query(
    `create index if not exists idx_articles_published_at on articles(published_at desc);`,
  );

  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `);
  await query(
    `create unique index if not exists idx_clusters_key on clusters(key);`,
  );
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `);
}

// ---------- DB helpers ----------
// Removed upsertSources function - sources are now managed directly in database

async function sourceMap(): Promise<Record<string, { id: number }>> {
  const { rows } = await query<{ id: number; feed_url: string }>(
    `select id, feed_url from sources`,
  );
  const map: Record<string, { id: number }> = {};
  for (const r of rows) map[r.feed_url] = { id: r.id };
  return map;
}

// ---------- Fetch sources from database ----------
async function fetchSourcesFromDB(): Promise<SourceDef[]> {
  const { rows } = await query<{
    id: number;
    name: string;
    homepage_url: string | null;
    feed_url: string;
    weight: number;
    slug: string;
  }>(`
    SELECT id, name, homepage_url, feed_url, weight, slug
    FROM sources
    WHERE feed_url LIKE 'http%'
    ORDER BY weight DESC, name
  `);

  return rows.map((row) => ({
    name: row.name,
    homepage: row.homepage_url || "",
    feed: row.feed_url,
    weight: row.weight,
    slug: row.slug,
  }));
}

function parseDateMaybe(s?: string) {
  if (!s) return null;
  const d = dayjs(s);
  return d.isValid() ? d.toDate() : null;
}

async function insertArticle(
  sourceId: number,
  title: string,
  url: string,
  publishedAt?: string,
  dek?: string | null,
  author?: string | null,
  // defaulted param must NOT be optional
  pub: { name?: string; homepage?: string } = {},
  language?: LanguageDetection,
) {
  // Parse and validate the date
  const parsedDate = parseDateMaybe(publishedAt);
  const dateValidation = isValidArticleDate(parsedDate);

  if (!dateValidation.valid) {
    console.log(
      `⚠️  Skipping article with invalid date (${dateValidation.reason}): "${title.substring(0, 60)}..."`,
    );
    return null;
  }

  // DEDUPLICATION (before embedding, to avoid wasted OpenAI calls): shared
  // rule in lib/articleDedupe.ts — same URL, or same title within 7 days.
  // Either way the article already exists — return an isExisting marker so the
  // caller skips re-clustering and re-categorizing it. Feeds keep items in the
  // window for days, so without this the full feed window was re-processed on
  // every one of the ~9 ingest runs/day (inflating `inserted`, breaking feed
  // health, and re-running hybrid categorization for unchanged articles).
  const existingId = await findRecentDuplicate({ title, url });
  if (existingId !== null) {
    return { id: existingId, embedding: null, isExisting: true };
  }

  // Generate embedding for the article
  const embedding = await generateEmbedding(title, dek ?? undefined);
  const embeddingJson = embedding.length > 0 ? JSON.stringify(embedding) : null;

  const row = await query<{ id: number; is_new: boolean }>(
    `
    insert into articles
      (source_id, title, canonical_url, published_at, dek, author, publisher_name, publisher_homepage, embedding, language_code, language_confidence, language_raw_code, language_source, language_checked_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    on conflict (canonical_url) do update set
      dek                 = coalesce(articles.dek, excluded.dek),
      author              = coalesce(articles.author, excluded.author),
      publisher_name      = coalesce(articles.publisher_name, excluded.publisher_name),
      publisher_homepage  = coalesce(articles.publisher_homepage, excluded.publisher_homepage),
      embedding           = coalesce(articles.embedding, excluded.embedding),
      language_code       = coalesce(articles.language_code, excluded.language_code),
      language_confidence = coalesce(articles.language_confidence, excluded.language_confidence),
      language_raw_code   = coalesce(articles.language_raw_code, excluded.language_raw_code),
      language_source     = coalesce(articles.language_source, excluded.language_source),
      language_checked_at = coalesce(articles.language_checked_at, excluded.language_checked_at)
    returning id, (xmax = 0) as is_new
  `,
    [
      sourceId,
      title,
      url,
      parsedDate,
      dek ?? null,
      author ?? null,
      pub.name ?? null,
      pub.homepage ?? null,
      embeddingJson,
      language?.languageCode ?? null,
      language?.languageConfidence ?? null,
      language?.languageRawCode ?? null,
      language?.languageSource ?? null,
    ],
  );
  const id = row.rows[0]?.id;
  if (!id) return null;
  // A conflicting URL that already existed (xmax<>0) is an update, not a new
  // article — flag it so the caller doesn't re-cluster/re-categorize it.
  const isExisting = row.rows[0]?.is_new === false;
  return { id, embedding: embeddingJson, isExisting };
}

// Update cluster metadata (lead article, size) when new articles are added
// NOTE: Does NOT update score - that's handled by rescore.ts which has the
// proper scoring algorithm with freshness decay, source weights, etc.
// ---------- Source health tracking ----------
async function updateSourceHealth(
  sourceId: number,
  status: "ok" | "error" | "empty",
  count: number,
) {
  try {
    await query(
      `UPDATE sources
       SET last_fetched_at = NOW(), last_fetch_status = $2, last_fetch_count = $3
       WHERE id = $1`,
      [sourceId, status, count],
    );
  } catch {
    // Never break ingestion if health tracking fails
  }
}

// ---------- Ingest one feed ----------
async function ingestFromFeed(feedUrl: string, sourceId: number, limit = 20) {
  let feed;
  try {
    feed = await parser.parseURL(feedUrl);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`Feed error for ${feedUrl}: ${message}`);
    await updateSourceHealth(sourceId, "error", 0);
    return { scanned: 0, inserted: 0 };
  }

  const items = (feed.items || []) as RssItem[];
  const slice = items.slice(0, limit);

  const fromGoogle = isGoogleNewsFeed(feedUrl);
  let inserted = 0;

  for (const it of slice) {
    let title = (it.title || "").trim();
    let link = (it.link || "").trim();
    if (!title || !link) continue;

    // Unwrap Google wrapper → real publisher URL when available
    if (fromGoogle) link = unGoogleLink(link);

    const dek = bestDek(it);

    // Climate relevance check - skip non-climate articles before insertion
    if (!isClimateRelevant({ title, summary: dek })) {
      console.log(`⏭️  Skipped (not climate): "${title.substring(0, 60)}..."`);
      continue;
    }

    const languageGate = classifyArticleLanguageForIngest(title, dek);
    if (languageGate.skip) {
      console.log(
        `⏭️  Skipped (${languageGate.language.languageCode}): "${title.substring(0, 60)}..."`,
      );
      continue;
    }
    const { language } = languageGate;

    const rawAuthor = (it.creator || it.author || null) as string | null;
    const author = rawAuthor ? decodeHtmlEntities(rawAuthor.trim()) : null;

    let pub: { name?: string; homepage?: string } = {};
    if (fromGoogle) {
      pub = extractPublisherFromGoogleItem(it);
      if (pub.name) {
        // Clean trailing " - Publisher" now that we store publisher separately
        title = cleanGoogleNewsTitle(title);
      }
    }

    const url = canonical(link);
    const result = await insertArticle(
      sourceId,
      title,
      url,
      it.isoDate || it.pubDate,
      dek,
      author,
      pub,
      language,
    );
    // Only treat genuinely new articles as inserts. Already-seen articles
    // (duplicate URL/title) skip clustering + categorization — they were done
    // when the article first arrived, and re-running them every cron is wasted
    // work that also corrupts the `inserted` count feeding source health.
    if (result && !result.isExisting) {
      inserted++;
      // Use semantic clustering instead of keyword-based clustering
      try {
        await assignArticleToCluster(result.id, title, {
          embedding: result.embedding,
        });
      } catch (error) {
        console.error(
          `  ❌ CLUSTERING FAILED for article ${result.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Don't fail the whole feed if clustering fails — cluster-maintenance cron will pick it up
      }

      // Categorize the article using hybrid approach
      try {
        await categorizeAndStoreArticle(result.id, title, dek || undefined);
        console.log(`  📝 Categorized article: ${title.slice(0, 50)}...`);
      } catch (error) {
        console.error(
          `  ❌ CATEGORIZATION FAILED for article ${result.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(`     Title: "${title}"`);
        // Don't fail the whole ingestion if categorization fails — categorize cron will retry
      }
    }
  }

  await updateSourceHealth(sourceId, inserted > 0 ? "ok" : "empty", inserted);
  return { scanned: slice.length, inserted };
}

// ---------- Main (export) ----------
export async function run(opts: { limit?: number; closePool?: boolean } = {}) {
  const start = Date.now();
  // schema.ts (`bun run schema`) is the single source of truth for DDL. Running
  // the full ensureSchema on every cron showed up in prod query stats; gate it
  // behind an opt-in flag so normal runs skip ~10 redundant DDL statements.
  if (process.env.SCHEMA_ENSURE === "1") await ensureSchema();

  // Fetch sources from database instead of JSON file
  const defs = await fetchSourcesFromDB();

  if (defs.length === 0) {
    console.log(
      "⚠️  No sources found in database. Make sure sources are properly configured.",
    );
    if (opts.closePool) await endPool();
    return { total: 0, results: [] };
  }

  const idByFeed = await sourceMap();

  const perFeedLimit = opts.limit ?? 25;
  const results = await mapLimit(defs, 4, async (s) => {
    try {
      const sid = idByFeed[s.feed]?.id;
      if (!sid)
        return {
          name: s.name,
          scanned: 0,
          inserted: 0,
          error: "source id missing",
        };
      const { scanned, inserted } = await ingestFromFeed(
        s.feed,
        sid,
        perFeedLimit,
      );
      return { name: s.name, scanned, inserted };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        name: s.name,
        scanned: 0,
        inserted: 0,
        error: message,
      };
    }
  });

  const total = results.reduce((sum, r) => sum + (r.inserted || 0), 0);
  console.log("Ingest results:", results);
  console.log(
    `Done. Inserted ${total} in ${Math.round((Date.now() - start) / 1000)}s.`,
  );

  if (opts.closePool) await endPool();
  return { total, results };
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true })
    .then(() => {
      console.log("✅ Ingest completed successfully");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Ingest failed:", err);
      endPool().finally(() => process.exit(1));
    });
}
