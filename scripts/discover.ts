// scripts/discover.ts
import Parser from "rss-parser";
import dayjs from "dayjs";
import { query, endPool } from "@/lib/db";
import { isClimateRelevant } from "@/lib/tagger";
import { generateEmbedding, assignArticleToCluster } from "@/lib/clustering";
import {
  classifyArticleLanguageForIngest,
  type LanguageDetection,
} from "@/lib/language";
import {
  canonical,
  mapLimit,
  isValidArticleDate,
  cleanGoogleNewsTitle,
} from "@/lib/utils";
import { resolveTier } from "@/config/sourceTiers";
import { resolveGoogleNewsUrl } from "@/lib/googleNews";
import { findRecentDuplicate } from "@/lib/articleDedupe";

type RssItem = {
  title?: string;
  link?: string;
  isoDate?: string;
  pubDate?: string;
  // Google News RSS <source url="https://publisher.com">Publisher</source>
  source?: string | { _?: string; $?: { url?: string } };
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

// Per-run cap on GN token resolutions (each costs 1-2 HTTP calls to Google).
// Items over the cap are inserted unresolved; they stay clusterable but
// lead-ineligible, and the backfill script can resolve them later.
const RESOLVE_CAP = Math.max(0, Number(process.env.DISCOVER_RESOLVE_CAP || 80));

function extractPublisher(it: RssItem): {
  name: string | null;
  homepage: string | null;
} {
  const src = it.source;
  if (!src) return { name: null, homepage: null };
  if (typeof src === "string") {
    return { name: src.trim() || null, homepage: null };
  }
  return {
    name: (src._ ?? "").trim() || null,
    homepage: src.$?.url?.trim() || null,
  };
}

// ------- minimal schema guards (safe if already run elsewhere) -------
async function ensureSchema() {
  await query(`
    create table if not exists sources (
      id            bigserial primary key,
      name          text not null,
      homepage_url  text,
      feed_url      text not null unique,
      weight        int not null default 2,
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
  const weight = resolveTier(name) ?? 2;

  const { rows } = await query<{ id: number }>(
    `
      insert into sources (name, homepage_url, feed_url, weight, slug)
      values ($1, $2, $3, $4, $5)
      on conflict (feed_url) do update set
        name = excluded.name,
        homepage_url = excluded.homepage_url,
        slug = excluded.slug
      returning id
    `,
    [name, homepage, feed, weight, slug],
  );
  return rows[0].id;
}

async function insertArticle(
  sourceId: number,
  title: string,
  url: string,
  publishedAt?: string,
  language?: LanguageDetection,
  publisher?: { name: string | null; homepage: string | null },
) {
  // Skip duplicates before generating embedding to avoid wasted OpenAI API calls
  if ((await findRecentDuplicate({ title, url })) !== null) return undefined;

  // Validate the date before spending an OpenAI embedding call. Mirrors
  // ingest.ts / discover-web.ts; discover.ts previously inserted unvalidated
  // dates, so a null/future published_at could waste an embed and (for future
  // dates) inflate cluster freshness in rescore.
  const parsedDate = publishedAt ? dayjs(publishedAt).toDate() : null;
  const dateCheck = isValidArticleDate(parsedDate);
  if (!dateCheck.valid) {
    console.log(
      `⚠️  Skipping discovered article with invalid date (${dateCheck.reason}): "${title.slice(0, 60)}..."`,
    );
    return undefined;
  }

  const embedding = await generateEmbedding(title);
  const row = await query<{ id: number }>(
    `
    INSERT INTO articles (
      source_id,
      title,
      canonical_url,
      published_at,
      embedding,
      language_code,
      language_confidence,
      language_raw_code,
      language_source,
      language_checked_at,
      publisher_name,
      publisher_homepage
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
    ON CONFLICT (canonical_url) DO NOTHING
    RETURNING id
  `,
    [
      sourceId,
      title,
      url,
      parsedDate,
      embedding.length > 0 ? JSON.stringify(embedding) : null,
      language?.languageCode ?? null,
      language?.languageConfidence ?? null,
      language?.languageRawCode ?? null,
      language?.languageSource ?? null,
      publisher?.name ?? null,
      publisher?.homepage ?? null,
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

type RunBudget = {
  remaining: number;
  resolved: number;
  unresolved: number;
  // Wall-clock deadline (Date.now() ms). Past it, stop processing new items so
  // a time-budgeted cron degrades to partial coverage instead of a hard kill.
  deadlineAt: number;
};

async function ingestQuery(
  q: string,
  limitPerQuery = 25,
  budget: RunBudget = {
    remaining: RESOLVE_CAP,
    resolved: 0,
    unresolved: 0,
    deadlineAt: Infinity,
  },
) {
  const parser = new Parser({
    headers: {
      // polite but browsery UA; helps some endpoints
      "User-Agent":
        "Mozilla/5.0 (compatible; ClimateRiverBot/0.1; +https://climateriver.org)",
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
    requestOptions: { timeout: 20000 },
    customFields: { item: ["source"] },
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
    if (Date.now() > budget.deadlineAt) {
      console.log(`⏱️  Deadline reached — stopping discover query "${q}"`);
      break;
    }
    scanned++;
    const title = (it.title || "").trim();
    const raw = (it.link || "").trim();
    if (!title || !raw) continue;

    // Climate relevance check - skip non-climate articles before insertion
    if (!isClimateRelevant({ title, summary: undefined })) {
      console.log(`⏭️  Skipped (not climate): "${title.substring(0, 60)}..."`);
      continue;
    }

    const languageGate = classifyArticleLanguageForIngest(title);
    if (languageGate.skip) {
      console.log(
        `⏭️  Skipped (${languageGate.language.languageCode}): "${title.substring(0, 60)}..."`,
      );
      continue;
    }
    const { language } = languageGate;

    // Strip the " - Publisher" suffix Google News appends, so the stored title
    // and its embedding match the ingest path (which already cleans these).
    const cleanTitle = cleanGoogleNewsTitle(title);

    // Feeds keep items in the window for days; skip already-seen titles BEFORE
    // paying for URL resolution or embedding (shared rule: lib/articleDedupe).
    if ((await findRecentDuplicate({ title: cleanTitle })) !== null) continue;

    // Resolve the GN redirect to the real publisher URL. Unresolved articles
    // are still inserted (they corroborate clusters) but keep the aggregator
    // host, which downstream treats as lead-ineligible. The resolve budget is
    // only spent on actual news.google.com links — passthrough URLs cost no
    // network call and shouldn't consume it.
    let urlCanon = canonical(raw);
    const isGnLink = (() => {
      try {
        return new URL(raw).hostname.endsWith("news.google.com");
      } catch {
        return false;
      }
    })();
    if (isGnLink && budget.remaining > 0) {
      budget.remaining--;
      const resolution = await resolveGoogleNewsUrl(raw);
      if (resolution.url && resolution.method !== "passthrough") {
        urlCanon = canonical(resolution.url);
        budget.resolved++;
      } else {
        budget.unresolved++;
      }
    }

    let host = "";
    try {
      host = new URL(urlCanon).hostname;
    } catch {
      continue;
    }
    const publisher = extractPublisher(it);
    const sid = await upsertSourceForHost(host);
    const id = await insertArticle(
      sid,
      cleanTitle,
      urlCanon,
      it.isoDate || it.pubDate,
      language,
      publisher,
    );
    if (id) {
      inserted++;
      await assignArticleToCluster(id, cleanTitle);
    }
  }

  return { scanned, inserted };
}

export async function run(
  opts: {
    limitPerQuery?: number;
    // Accept `limit` as an alias so the full cron's `?discover=` knob (which
    // passes `limit`) actually takes effect — it was silently ignored before.
    limit?: number;
    // Relative time budget (ms from now); item processing stops past it.
    deadlineMs?: number;
    closePool?: boolean;
  } = {},
) {
  // schema.ts owns DDL; skip the per-run guard unless explicitly opted in.
  if (process.env.SCHEMA_ENSURE === "1") await ensureSchema();

  const queries = process.env.DISCOVER_QUERIES
    ? process.env.DISCOVER_QUERIES.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_QUERIES;

  const limitPerQuery = Math.max(
    5,
    Math.min(50, opts.limitPerQuery ?? opts.limit ?? 20),
  );

  // Shared across queries so the per-run resolution cap and deadline are global.
  const budget: RunBudget = {
    remaining: RESOLVE_CAP,
    resolved: 0,
    unresolved: 0,
    deadlineAt: opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity,
  };

  const results = await mapLimit(queries, 4, (q) =>
    ingestQuery(q, limitPerQuery, budget),
  );
  const scanned = results.reduce((a, b) => a + b.scanned, 0);
  const inserted = results.reduce((a, b) => a + b.inserted, 0);

  if (opts.closePool) await endPool();
  return {
    queries: queries.length,
    scanned,
    inserted,
    urlsResolved: budget.resolved,
    urlsUnresolved: budget.unresolved,
  };
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
