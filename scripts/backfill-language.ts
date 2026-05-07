import { query, endPool } from "@/lib/db";
import {
  detectBestArticleLanguage,
  type LanguageDetection,
} from "@/lib/language";

const DEFAULT_LIMIT = 500;
const DEFAULT_BATCH_SIZE = 200;
const CONTENT_TEXT_DETECTION_CHARS = 12_000;

type BackfillOptions = {
  apply?: boolean;
  limit?: number;
  batchSize?: number;
  includeChecked?: boolean;
  closePool?: boolean;
};

type ArticleRow = {
  id: number;
  title: string;
  dek: string | null;
  content_text: string | null;
  language_code: string | null;
  language_confidence: number | null;
  language_raw_code: string | null;
  language_source: string | null;
  language_checked_at: Date | null;
};

type LanguageUpdate = {
  id: number;
  detection: LanguageDetection;
};

type BackfillStats = {
  scanned: number;
  updated: number;
  english: number;
  nonEnglish: number;
  unknown: number;
};

const LANGUAGE_COLUMNS = [
  "language_code",
  "language_confidence",
  "language_raw_code",
  "language_source",
  "language_checked_at",
] as const;

async function articleColumnExists(columnName: string) {
  const { rows } = await query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'articles'
        AND column_name = $1
    ) AS exists
  `,
    [columnName],
  );

  return Boolean(rows[0]?.exists);
}

async function languageColumnsExist() {
  const checks = await Promise.all(
    LANGUAGE_COLUMNS.map((column) => articleColumnExists(column)),
  );
  return checks.every(Boolean);
}

function parseNumberFlag(name: string, fallback: number) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  if (!value) return fallback;

  const parsed = Number(value.slice(prefix.length));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function detectionChanged(article: ArticleRow, detection: LanguageDetection) {
  return (
    article.language_checked_at === null ||
    article.language_code !== detection.languageCode ||
    article.language_confidence !== detection.languageConfidence ||
    article.language_raw_code !== detection.languageRawCode ||
    article.language_source !== detection.languageSource
  );
}

async function fetchBatch(options: {
  afterId: number;
  batchSize: number;
  includeChecked: boolean;
  hasLanguageColumns: boolean;
}) {
  const languageSelect = options.hasLanguageColumns
    ? `
      language_code,
      language_confidence,
      language_raw_code,
      language_source,
      language_checked_at
    `
    : `
      null::text AS language_code,
      null::real AS language_confidence,
      null::text AS language_raw_code,
      null::text AS language_source,
      null::timestamptz AS language_checked_at
    `;
  const checkedFilter =
    options.hasLanguageColumns && !options.includeChecked
      ? "AND language_checked_at IS NULL"
      : "";

  const { rows } = await query<ArticleRow>(
    `
    SELECT
      id,
      title,
      dek,
      left(content_text, $3)::text AS content_text,
      ${languageSelect}
    FROM articles
    WHERE id > $1
      ${checkedFilter}
    ORDER BY id
    LIMIT $2
  `,
    [options.afterId, options.batchSize, CONTENT_TEXT_DETECTION_CHARS],
  );

  return rows;
}

async function applyUpdates(updates: LanguageUpdate[]) {
  if (updates.length === 0) return 0;

  const params: Array<number | string | null> = [];
  const tuples = updates.map((update, index) => {
    const base = index * 5;
    params.push(
      update.id,
      update.detection.languageCode,
      update.detection.languageConfidence,
      update.detection.languageRawCode,
      update.detection.languageSource,
    );
    return `($${base + 1}::bigint, $${base + 2}::text, $${base + 3}::real, $${base + 4}::text, $${base + 5}::text)`;
  });

  const { rowCount } = await query(
    `
    UPDATE articles a
    SET
      language_code = v.language_code,
      language_confidence = v.language_confidence,
      language_raw_code = v.language_raw_code,
      language_source = v.language_source,
      language_checked_at = NOW()
    FROM (
      VALUES ${tuples.join(",\n             ")}
    ) AS v(id, language_code, language_confidence, language_raw_code, language_source)
    WHERE a.id = v.id
      AND (
        a.language_checked_at IS NULL
        OR a.language_code IS DISTINCT FROM v.language_code
        OR a.language_confidence IS DISTINCT FROM v.language_confidence
        OR a.language_raw_code IS DISTINCT FROM v.language_raw_code
        OR a.language_source IS DISTINCT FROM v.language_source
      )
  `,
    params,
  );

  return rowCount;
}

export async function run(opts: BackfillOptions = {}) {
  const apply = Boolean(opts.apply);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const includeChecked = Boolean(opts.includeChecked);
  const hasLanguageColumns = await languageColumnsExist();

  if (apply && !hasLanguageColumns) {
    throw new Error(
      "Language columns are missing. Run `bun run schema` before `bun run language:backfill:apply`.",
    );
  }

  const stats: BackfillStats = {
    scanned: 0,
    updated: 0,
    english: 0,
    nonEnglish: 0,
    unknown: 0,
  };
  const nonEnglishExamples: string[] = [];
  let lastId = 0;

  while (limit === 0 || stats.scanned < limit) {
    const remaining =
      limit === 0 ? batchSize : Math.min(batchSize, limit - stats.scanned);
    const rows = await fetchBatch({
      afterId: lastId,
      batchSize: remaining,
      includeChecked,
      hasLanguageColumns,
    });
    if (rows.length === 0) break;

    const updates: LanguageUpdate[] = [];
    for (const article of rows) {
      lastId = article.id;
      stats.scanned++;

      const detection = detectBestArticleLanguage({
        title: article.title,
        dek: article.dek,
        contentText: article.content_text,
      });

      if (detection.languageCode === "en") stats.english++;
      else if (detection.languageCode === null) stats.unknown++;
      else {
        stats.nonEnglish++;
        if (nonEnglishExamples.length < 8) {
          nonEnglishExamples.push(
            `${article.id} [${detection.languageCode}/${detection.languageRawCode}]: ${article.title.slice(0, 90)}`,
          );
        }
      }

      if (apply && detectionChanged(article, detection)) {
        updates.push({ id: article.id, detection });
      }
    }

    if (apply) {
      stats.updated += await applyUpdates(updates);
    }
  }

  console.log(
    `${apply ? "Applied" : "Dry run"} language backfill: ${stats.scanned} scanned, ${stats.updated} updated`,
  );
  console.log(
    `  English: ${stats.english} | Non-English: ${stats.nonEnglish} | Unknown: ${stats.unknown}`,
  );

  if (nonEnglishExamples.length > 0) {
    console.log("\n  Non-English examples:");
    for (const example of nonEnglishExamples) {
      console.log(`  - ${example}`);
    }
  }

  if (!apply) {
    console.log("\nRun with --apply to write language metadata.");
  }

  if (opts.closePool) await endPool();
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run({
    apply: process.argv.includes("--apply"),
    includeChecked: process.argv.includes("--all"),
    limit: parseNumberFlag("limit", DEFAULT_LIMIT),
    batchSize: parseNumberFlag("batch-size", DEFAULT_BATCH_SIZE),
    closePool: true,
  }).catch((err) => {
    console.error("Language backfill failed:", err);
    endPool().finally(() => process.exit(1));
  });
}
