// scripts/ingest.ts
import Parser from "rss-parser";
import dayjs from "dayjs";
import { query, endPool } from "@/lib/db";
import { categorizeAndStoreArticle } from "@/lib/categorizer";
import { isClimateRelevant } from "@/lib/tagger";
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";

// ---------- Parser configured once (captures <source>, rich content) ----------
type RssSourceField =
  | string
  | {
      ["#"]?: string;
      _?: string;
      text?: string;
      value?: string;
      $?: {
        url?: string;
      };
      url?: string;
    };

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

// Generate embedding for article content
async function generateEmbedding(
  title: string,
  description?: string,
): Promise<number[]> {
  try {
    // Combine title and description for better semantic understanding
    const text = description ? `${title}\n\n${description}` : title;

    // Truncate to prevent token limit issues (rough estimate: 1 token ≈ 4 chars)
    const truncatedText = text.substring(0, 8000);

    const { embedding } = await embed({
      model: openai.embeddingModel("text-embedding-3-small"),
      value: truncatedText,
    });

    return embedding;
  } catch (error) {
    console.error("Error generating embedding:", error);
    return [];
  }
}

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

function extractPublisherFromGoogleItem(item: RssItem): {
  name?: string;
  homepage?: string;
} {
  const src = item.source;
  const first = Array.isArray(src) ? src[0] : src;
  if (typeof first === "string") {
    const trimmed = first.trim();
    if (trimmed) return { name: decodeHtmlEntities(trimmed) };
  } else if (first && typeof first === "object") {
    const rawName =
      (typeof first["#"] === "string" && first["#"]) ||
      (typeof first._ === "string" && first._) ||
      (typeof first.text === "string" && first.text) ||
      (typeof first.value === "string" && first.value) ||
      undefined;
    const homepage =
      (typeof first.$?.url === "string" && first.$.url) ||
      (typeof first.url === "string" && first.url) ||
      undefined;
    if (rawName || homepage) {
      return {
        name: rawName ? decodeHtmlEntities(rawName.trim()) : undefined,
        homepage,
      };
    }
  }

  // Fallback: title suffix like "Title — Publisher"
  if (item.title) {
    const m = item.title.match(/\s[-—]\s([^]+)$/);
    if (m) {
      const name = decodeHtmlEntities(m[1].trim());
      const homepage = /\b[a-z0-9.-]+\.[a-z]{2,}\b/i.test(name)
        ? `https://${name}`
        : undefined;
      return { name, homepage };
    }
  }
  return {};
}

function cleanGoogleNewsTitle(title: string) {
  return title.replace(/\s[-—]\s[^-—]+$/, "").trim();
}

function stripHtml(s: string) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(s: string) {
  return (s || "")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
function pick(...vals: Array<string | undefined | null>) {
  for (const v of vals) if (v && v.trim()) return v;
  return "";
}
function oneLine(raw: string, max = 200) {
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
function canonical(url: string) {
  try {
    const u = new URL(url);
    [...u.searchParams.keys()].forEach((k) => {
      if (/^utm_|^fbclid$|^gclid$|^mc_/i.test(k)) u.searchParams.delete(k);
    });
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}
function clusterKey(title: string) {
  const t = (title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const STOP = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "by",
    "from",
    "at",
    "is",
    "are",
    "was",
    "were",
    "be",
    "as",
  ]);
  const kept = words.filter((w) => !STOP.has(w) && w.length >= 3);
  return kept.slice(0, 8).join("-");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, idx: number) => Promise<R>,
) {
  const ret: R[] = new Array(items.length);
  let i = 0,
    active = 0;
  return new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(ret);
      while (active < limit && i < items.length) {
        const cur = i++;
        active++;
        fn(items[cur], cur)
          .then((v) => (ret[cur] = v))
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
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
    WHERE feed_url IS NOT NULL 
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

// Validate that a date is reasonable for a news article (not future, not too old)
function isValidArticleDate(date: Date | null): {
  valid: boolean;
  reason?: string;
} {
  if (!date) return { valid: false, reason: "missing date" };

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneMinuteFromNow = new Date(now.getTime() + 60 * 1000);

  // Reject future dates (with 1 minute grace for clock skew)
  if (date > oneMinuteFromNow) {
    return { valid: false, reason: `future date: ${date.toISOString()}` };
  }

  // Warn if date is very close to now (within 30 seconds) - likely a fallback to NOW()
  if (Math.abs(date.getTime() - now.getTime()) < 30 * 1000) {
    return {
      valid: false,
      reason:
        "date suspiciously close to current time (likely parsing failure)",
    };
  }

  // Reject articles older than 30 days for RSS ingestion
  if (date < thirtyDaysAgo) {
    return { valid: false, reason: `too old: ${date.toISOString()}` };
  }

  return { valid: true };
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

  // ENHANCED DEDUPLICATION: Check for existing articles with same/similar title
  const titleCheck = await query<{ id: number; canonical_url: string }>(
    `SELECT id, canonical_url FROM articles 
     WHERE title = $1 
       AND fetched_at >= now() - interval '7 days'
     LIMIT 1`,
    [title],
  );

  if (titleCheck.rows.length > 0) {
    console.log(
      `⚠️  Duplicate title detected: "${title.substring(0, 50)}..." - skipping (existing ID: ${titleCheck.rows[0].id})`,
    );
    return titleCheck.rows[0].id; // Return existing article ID
  }

  // Generate embedding for the article
  const embedding = await generateEmbedding(title, dek ?? undefined);

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
      parsedDate,
      dek ?? null,
      author ?? null,
      pub.name ?? null,
      pub.homepage ?? null,
      embedding.length > 0 ? JSON.stringify(embedding) : null,
    ],
  );
  return row.rows[0]?.id;
}

// Update cluster metadata (lead article, size) when new articles are added
// NOTE: Does NOT update score - that's handled by rescore.ts which has the
// proper scoring algorithm with freshness decay, source weights, etc.
async function updateClusterMetadata(clusterId: number) {
  try {
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
        0 as score  -- Placeholder; rescore.ts calculates proper score
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
        -- NOTE: Do NOT update score here - rescore.ts handles that
    `,
      [clusterId],
    );
  } catch (error) {
    console.error(
      `Failed to update cluster metadata for cluster ${clusterId}:`,
      error,
    );
    // Don't fail the whole process if metadata update fails
  }
}

// New semantic clustering function using vector embeddings
async function ensureSemanticClusterForArticle(
  articleId: number,
  title: string,
) {
  // Check if this article is already in ANY cluster
  const articleAlreadyClustered = await query<{ cluster_id: number }>(
    `SELECT cluster_id FROM article_clusters WHERE article_id = $1`,
    [articleId],
  );

  if (articleAlreadyClustered.rows.length > 0) {
    console.log(
      `Article ${articleId} already in cluster ${articleAlreadyClustered.rows[0].cluster_id}, skipping`,
    );
    return;
  }

  // Get the article's embedding
  const articleResult = await query<{ embedding: string }>(
    `SELECT embedding FROM articles WHERE id = $1 AND embedding IS NOT NULL`,
    [articleId],
  );

  if (articleResult.rows.length === 0) {
    console.log(`Article ${articleId} has no embedding, skipping clustering`);
    return;
  }

  const articleEmbedding = articleResult.rows[0].embedding;

  // Find similar articles using cosine similarity
  const similarArticles = await query<{
    article_id: number;
    cluster_id: number | null;
    similarity: number;
    title: string;
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
    [articleEmbedding, articleId],
  );

  // Look for existing clusters among similar articles
  // Find all unique clusters and their best similarity scores
  const clusterCandidates = new Map<
    number,
    {
      similarity: number;
      article_id: number;
      title: string;
    }
  >();

  for (const similar of similarArticles.rows) {
    if (similar.cluster_id) {
      const existing = clusterCandidates.get(similar.cluster_id);
      if (!existing || similar.similarity > existing.similarity) {
        clusterCandidates.set(similar.cluster_id, {
          similarity: similar.similarity,
          article_id: similar.article_id,
          title: similar.title,
        });
      }
    }
  }

  // If we found cluster candidates, join the one with highest similarity
  if (clusterCandidates.size > 0) {
    const bestCluster = Array.from(clusterCandidates.entries()).sort(
      ([, a], [, b]) => b.similarity - a.similarity,
    )[0];

    const [clusterId, bestMatch] = bestCluster;

    console.log(
      `Article ${articleId} matched existing cluster ${clusterId} via similar article ${bestMatch.article_id} (similarity: ${bestMatch.similarity.toFixed(3)}) - "${bestMatch.title}"`,
    );

    // Add this article to the best matching cluster
    await query(
      `INSERT INTO article_clusters (article_id, cluster_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [articleId, clusterId],
    );

    // Also add any unclustered similar articles to this cluster (retroactive clustering)
    const unclusteredSimilar = similarArticles.rows.filter(
      (a) => !a.cluster_id && a.similarity >= 0.6,
    );
    for (const unclustered of unclusteredSimilar) {
      await query(
        `INSERT INTO article_clusters (article_id, cluster_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [unclustered.article_id, clusterId],
      );
      console.log(
        `  ↳ Added unclustered article ${unclustered.article_id} to cluster ${clusterId} (similarity: ${unclustered.similarity.toFixed(3)})`,
      );
    }

    // Update cluster_scores to potentially select a better lead article
    await updateClusterMetadata(clusterId);
    return;
  }

  // If we have similar articles but no existing cluster, create a new one
  if (similarArticles.rows.length > 0) {
    const key = clusterKey(title) || `semantic-${Date.now()}`;

    const cluster = await query<{ id: number }>(
      `INSERT INTO clusters (key) VALUES ($1)
       ON CONFLICT (key) DO UPDATE SET key = excluded.key
       RETURNING id`,
      [key],
    );

    const clusterId = cluster.rows[0].id;

    // Add the current article to the new cluster
    await query(
      `INSERT INTO article_clusters (article_id, cluster_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [articleId, clusterId],
    );

    // Add all similar articles to the new cluster
    for (const similar of similarArticles.rows) {
      await query(
        `INSERT INTO article_clusters (article_id, cluster_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [similar.article_id, clusterId],
      );
    }

    console.log(
      `Created new semantic cluster ${clusterId} with ${similarArticles.rows.length + 1} articles`,
    );

    // Initialize cluster_scores for the new cluster
    await updateClusterMetadata(clusterId);
    return;
  }

  // No similar articles found - article remains unclustered
  console.log(
    `Article ${articleId} - no similar articles found, remains unclustered`,
  );
}

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
    const articleId = await insertArticle(
      sourceId,
      title,
      url,
      it.isoDate || it.pubDate,
      dek,
      author,
      pub,
    );
    if (articleId) {
      inserted++;
      // Use semantic clustering instead of keyword-based clustering
      try {
        await ensureSemanticClusterForArticle(articleId, title);
      } catch (error) {
        console.error(
          `  ❌ CLUSTERING FAILED for article ${articleId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Don't fail the whole feed if clustering fails — cluster-maintenance cron will pick it up
      }

      // Categorize the article using hybrid approach
      try {
        await categorizeAndStoreArticle(articleId, title, dek || undefined);
        console.log(`  📝 Categorized article: ${title.slice(0, 50)}...`);
      } catch (error) {
        console.error(
          `  ❌ CATEGORIZATION FAILED for article ${articleId}: ${error instanceof Error ? error.message : String(error)}`,
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
  await ensureSchema();

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
