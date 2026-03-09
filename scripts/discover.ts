// scripts/discover.ts
import Parser from "rss-parser";
import dayjs from "dayjs";
import { query, endPool } from "@/lib/db";
import { isClimateRelevant } from "@/lib/tagger";
import { generateEmbedding, assignArticleToCluster } from "@/lib/clustering";
import { canonical, mapLimit } from "@/lib/utils";

type RssItem = {
  title?: string;
  link?: string;
  isoDate?: string;
  pubDate?: string;
};

// ------- config -------
const DEFAULT_QUERIES = [
  "climate change",
  "global warming",
  "carbon emissions",
  "renewable energy",
  "solar power",
  "wind power",
  "carbon capture",
  "EV sales",
  "heat wave",
  "wildfire",
  "flooding",
  "drought",
  "sea level rise",
  "IPCC",
];

// locale / edition for Google News (defaults to US-English)
const GN_HL = process.env.DISCOVER_HL || "en-US";
const GN_GL = process.env.DISCOVER_GL || "US";
const GN_CEID = process.env.DISCOVER_CEID || "US:en";

// ------- utils -------
function slugify(input: string) {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

/** Google News sometimes links to news.google.com/... with a ?url= param. Extract it if present. */
function resolveGoogleNewsLink(link: string) {
  try {
    const u = new URL(link);
    if (u.hostname.endsWith("news.google.com")) {
      const real = u.searchParams.get("url");
      if (real) return real;
    }
  } catch {
    // Ignore malformed URLs and fall back to the original link
  }
  return link;
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
  `);
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
  `);
  await query(`
    create table if not exists clusters (
      id         bigserial primary key,
      key        text unique,
      created_at timestamptz not null default now()
    );
  `);
  await query(`
    create table if not exists article_clusters (
      article_id bigint references articles(id) on delete cascade,
      cluster_id bigint references clusters(id) on delete cascade,
      primary key (article_id, cluster_id)
    );
  `);
}

// ------- DB helpers -------
async function upsertSourceForHost(host: string) {
  const name = host.replace(/^www\./, "");
  const homepage = `https://${name}`;
  const slug = slugify(name);
  const feed = `discover://${name}`; // stable pseudo-URL to satisfy NOT NULL + uniqueness

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
    [name, homepage, feed, slug],
  );
  return rows[0].id;
}

async function insertArticle(
  sourceId: number,
  title: string,
  url: string,
  publishedAt?: string,
) {
  // Skip duplicates before generating embedding to avoid wasted OpenAI API calls
  const existing = await query<{ id: number }>(
    `SELECT id FROM articles WHERE canonical_url = $1`,
    [url],
  );
  if (existing.rows.length > 0) return undefined;

  const embedding = await generateEmbedding(title);
  const row = await query<{ id: number }>(
    `
    INSERT INTO articles (source_id, title, canonical_url, published_at, embedding)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (canonical_url) DO NOTHING
    RETURNING id
  `,
    [
      sourceId,
      title,
      url,
      publishedAt ? dayjs(publishedAt).toDate() : null,
      embedding.length > 0 ? JSON.stringify(embedding) : null,
    ],
  );
  return row.rows[0]?.id;
}

// ------- main work -------
function googleNewsUrl(q: string) {
  const base = "https://news.google.com/rss/search";
  const qs = new URLSearchParams({
    q,
    hl: GN_HL,
    gl: GN_GL,
    ceid: GN_CEID,
  });
  return `${base}?${qs.toString()}`;
}

async function ingestQuery(q: string, limitPerQuery = 25) {
  const parser = new Parser({
    headers: {
      // polite but browsery UA; helps some endpoints
      "User-Agent":
        "Mozilla/5.0 (compatible; ClimateRiverBot/0.1; +https://climateriver.org)",
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
    requestOptions: { timeout: 20000 },
  });
  const url = googleNewsUrl(q);
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`Discover feed error for "${q}": ${message}`);
    return { scanned: 0, inserted: 0 };
  }

  const items = (feed.items || []) as RssItem[];
  let inserted = 0;
  let scanned = 0;

  for (const it of items.slice(0, limitPerQuery)) {
    scanned++;
    const title = (it.title || "").trim();
    const raw = (it.link || "").trim();
    if (!title || !raw) continue;

    const resolved = resolveGoogleNewsLink(raw);
    const urlCanon = canonical(resolved);

    // Climate relevance check - skip non-climate articles before insertion
    if (!isClimateRelevant({ title, summary: undefined })) {
      console.log(`⏭️  Skipped (not climate): "${title.substring(0, 60)}..."`);
      continue;
    }

    let host = "";
    try {
      host = new URL(urlCanon).hostname;
    } catch {
      continue;
    }
    const sid = await upsertSourceForHost(host);
    const id = await insertArticle(
      sid,
      title,
      urlCanon,
      it.isoDate || it.pubDate,
    );
    if (id) {
      inserted++;
      await assignArticleToCluster(id, title);
    }
  }

  return { scanned, inserted };
}

export async function run(
  opts: {
    limitPerQuery?: number;
    closePool?: boolean;
  } = {},
) {
  await ensureSchema();

  const queries = process.env.DISCOVER_QUERIES
    ? process.env.DISCOVER_QUERIES.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_QUERIES;

  const limitPerQuery = Math.max(5, Math.min(50, opts.limitPerQuery ?? 20));

  const results = await mapLimit(queries, 4, (q) =>
    ingestQuery(q, limitPerQuery),
  );
  const scanned = results.reduce((a, b) => a + b.scanned, 0);
  const inserted = results.reduce((a, b) => a + b.inserted, 0);

  if (opts.closePool) await endPool();
  return { queries: queries.length, scanned, inserted };
}

// CLI: npx tsx scripts/discover.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true })
    .then((r) => {
      console.log("Discover results:", r);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
