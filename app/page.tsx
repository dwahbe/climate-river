import Link from "next/link";
import { Sparkles } from "lucide-react";
import LocalTime from "@/components/LocalTime";
import RiverControls from "@/components/RiverControls";
import PublisherLink from "@/components/PublisherLink";
import SourceTooltip from "@/components/SourceTooltip";
import ReadNowButton from "@/components/ReadNowButton";
import { CATEGORIES } from "@/lib/tagger";
import { getRiverData } from "@/lib/services/riverService";
import type { ClusterArticle } from "@/lib/models/cluster";

// Cache for 5 minutes (300 seconds)
export const revalidate = 300;
export const runtime = "nodejs";

function hostFrom(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type ArticleIndexEntry = {
  key: string;
  normalizedKey: string;
  articles: ClusterArticle[];
};

function normalizeSourceKey(value?: string | null) {
  return value
    ? value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
    : "";
}

function buildArticleIndex(
  allArticles?: Record<string, ClusterArticle[]> | null
): Map<string, ArticleIndexEntry> {
  const index = new Map<string, ArticleIndexEntry>();

  if (!allArticles) {
    return index;
  }

  for (const [key, articles] of Object.entries(allArticles)) {
    const normalizedKey = normalizeSourceKey(key);

    if (!normalizedKey) {
      continue;
    }

    index.set(normalizedKey, {
      key,
      normalizedKey,
      articles,
    });
  }

  return index;
}

function findArticlesForSource(
  index: Map<string, ArticleIndexEntry>,
  sourceName: string,
  url: string
) {
  const candidates = [sourceName, hostFrom(url)].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const normalized = normalizeSourceKey(candidate);

    if (!normalized) {
      continue;
    }

    const exact = index.get(normalized);

    if (exact) {
      return exact.articles;
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeSourceKey(candidate);

    if (!normalized) {
      continue;
    }

    for (const entry of index.values()) {
      if (
        entry.normalizedKey.includes(normalized) ||
        normalized.includes(entry.normalizedKey)
      ) {
        return entry.articles;
      }
    }
  }

  return [];
}

export default async function RiverPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;

  const view = Array.isArray(searchParams?.view)
    ? searchParams?.view[0]
    : searchParams?.view;

  // Check if it's a category view
  const selectedCategory = CATEGORIES.find((c) => c.slug === view)?.slug;

  // Fetch data using the service layer
  const clusters = await getRiverData({
    view: view || "top",
    category: selectedCategory,
  });

  return (
    <>
      <header className="z-10 bg-transparent">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-2 sm:py-2.5">
          <RiverControls
            currentView={view}
            selectedCategory={selectedCategory}
          />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
        <section>
          {clusters.map((r) => {
            const secondaries = r.subs ?? [];
            const isCluster = r.size > 1;
            const publisher = r.lead_source || hostFrom(r.lead_url);
            const leadClickHref = `/api/click?aid=${r.lead_article_id}&url=${encodeURIComponent(
              r.lead_url,
            )}`;
            const articleIndex = buildArticleIndex(r.all_articles_by_source);
            const leadArticles = publisher
              ? findArticlesForSource(articleIndex, publisher, r.lead_url)
              : [];

            return (
              <article
                key={r.cluster_id}
                className="group relative py-5 sm:py-6 border-b border-zinc-200/70"
              >
                {(r.lead_author || publisher) && (
                  <div className="mb-1.5 flex items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500">
                      {r.lead_author && (
                        <span className="text-zinc-700">{r.lead_author}</span>
                      )}
                      {r.lead_author && publisher && (
                        <span className="text-zinc-400">•</span>
                      )}
                      <SourceTooltip
                        sourceName={publisher}
                        articles={leadArticles}
                      >
                        {r.lead_homepage ? (
                          <PublisherLink
                            href={r.lead_homepage}
                            className="hover:underline"
                          >
                            {publisher}
                          </PublisherLink>
                        ) : (
                          <span>{publisher}</span>
                        )}
                      </SourceTooltip>
                      {r.lead_was_rewritten && (
                        <span
                          className="inline-flex items-center text-amber-500"
                          title="Rewritten for improved context by Climate River"
                        >
                          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">
                            Rewritten for improved context by Climate River
                          </span>
                        </span>
                      )}
                    </div>
                    <ReadNowButton
                      articleId={r.lead_article_id}
                      articleTitle={r.lead_title}
                      articleUrl={r.lead_url}
                      contentStatus={r.lead_content_status}
                      contentWordCount={r.lead_content_word_count}
                    />
                  </div>
                )}

                <h3 className="text-[18px] sm:text-[19px] md:text-[20px] font-semibold leading-snug text-pretty">
                  <a
                    href={leadClickHref}
                    className="no-underline hover:underline text-zinc-950 hover:text-zinc-900 focus-visible:underline rounded transition"
                  >
                    {r.lead_title}
                  </a>
                </h3>

                {r.lead_dek && (
                  <p className="mt-1 hidden sm:block text-sm sm:text-[0.95rem] text-zinc-600 text-pretty">
                    {r.lead_dek}
                  </p>
                )}

                {/* Timestamp */}
                <div className="mt-2 text-xs text-zinc-500">
                  <LocalTime iso={r.published_at} />
                </div>

                {/* Read more sources */}
                {isCluster && secondaries.length > 0 && (
                  <div className="mt-2 text-sm text-zinc-700">
                    <Link
                      href={`/river/${r.cluster_id}`}
                      className="no-underline hover:underline text-zinc-600 hover:text-zinc-800 transition-colors font-medium"
                      prefetch={false}
                    >
                      Related articles:
                    </Link>
                    <span> </span>
                    {secondaries.map((s, i) => {
                      const href = `/api/click?aid=${s.article_id}&url=${encodeURIComponent(
                        s.url,
                      )}`;
                      const sourceName = s.source || hostFrom(s.url);
                      const articlesForSource = findArticlesForSource(
                        articleIndex,
                        sourceName,
                        s.url,
                      );
                      const articleCount =
                        s.article_count ??
                        (articlesForSource.length > 0
                          ? articlesForSource.length
                          : 1);
                      const linkLabel =
                        articleCount > 1
                          ? `${sourceName} (${articleCount})`
                          : sourceName;
                      return (
                        <span key={s.article_id}>
                          <SourceTooltip
                            sourceName={sourceName}
                            articles={articlesForSource}
                          >
                            <a
                              href={href}
                              className="no-underline hover:underline text-zinc-700 hover:text-zinc-900 transition-colors"
                            >
                              {linkLabel}
                            </a>
                          </SourceTooltip>
                          {i < secondaries.length - 1 && (
                            <span className="text-zinc-400">, </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      </div>
    </>
  );
}
