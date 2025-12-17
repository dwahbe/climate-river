import Link from "next/link";
import { Sparkles } from "lucide-react";
import LocalTime from "@/components/LocalTime";
import PublisherLink from "@/components/PublisherLink";
import SourceTooltip from "@/components/SourceTooltip";
import ReadNowButton from "@/components/ReadNowButton";
import type { Cluster, ClusterArticle } from "@/lib/models/cluster";

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
  allArticles?: Record<string, ClusterArticle[]> | null,
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
  url: string,
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

export default function RiverClusterList({
  clusters,
}: {
  clusters: Cluster[];
}) {
  return (
    <section>
      {clusters.map((cluster) => {
        const secondaries = cluster.subs ?? [];
        const isCluster = cluster.size > 1;
        const publisher = cluster.lead_source || hostFrom(cluster.lead_url);
        const leadClickHref = `/api/click?aid=${cluster.lead_article_id}&url=${encodeURIComponent(
          cluster.lead_url,
        )}`;
        const articleIndex = buildArticleIndex(cluster.all_articles_by_source);
        const leadArticles = publisher
          ? findArticlesForSource(articleIndex, publisher, cluster.lead_url)
          : [];

        return (
          <article
            key={cluster.cluster_id}
            className="group relative py-5 sm:py-6 border-b border-zinc-200/70"
          >
            {(cluster.lead_author || publisher) && (
              <div className="mb-1.5 flex items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] sm:text-xs font-medium tracking-wide text-zinc-500">
                  {cluster.lead_author && (
                    <span className="text-zinc-700">{cluster.lead_author}</span>
                  )}
                  {cluster.lead_author && publisher && (
                    <span className="text-zinc-400">•</span>
                  )}
                  <SourceTooltip sourceName={publisher} articles={leadArticles}>
                    {cluster.lead_homepage ? (
                      <PublisherLink
                        href={cluster.lead_homepage}
                        className="hover:underline"
                      >
                        {publisher}
                      </PublisherLink>
                    ) : (
                      <span>{publisher}</span>
                    )}
                  </SourceTooltip>
                  {cluster.lead_was_rewritten && (
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
                  articleId={cluster.lead_article_id}
                  articleTitle={cluster.lead_title}
                  articleUrl={cluster.lead_url}
                  contentStatus={cluster.lead_content_status}
                  contentWordCount={cluster.lead_content_word_count}
                />
              </div>
            )}

            <h3 className="text-[18px] sm:text-[19px] md:text-[20px] font-semibold leading-snug text-pretty">
              <a
                href={leadClickHref}
                className="no-underline hover:underline text-zinc-950 hover:text-zinc-900 focus-visible:underline rounded transition"
              >
                {cluster.lead_title}
              </a>
            </h3>

            {cluster.lead_dek && (
              <p className="mt-1 hidden sm:block text-sm sm:text-[0.95rem] text-zinc-600 text-pretty">
                {cluster.lead_dek}
              </p>
            )}

            <div className="mt-2 text-xs text-zinc-500">
              <LocalTime iso={cluster.published_at} />
            </div>

            {isCluster && secondaries.length > 0 && (
              <div className="mt-2 text-sm text-zinc-700">
                <Link
                  href={`/river/${cluster.cluster_id}`}
                  className="no-underline hover:underline text-zinc-600 hover:text-zinc-800 transition-colors font-medium"
                  prefetch={false}
                >
                  Related articles:
                </Link>
                <span> </span>
                {secondaries.map((subLink, index) => {
                  const href = `/api/click?aid=${subLink.article_id}&url=${encodeURIComponent(
                    subLink.url,
                  )}`;
                  const sourceName = subLink.source || hostFrom(subLink.url);
                  const articlesForSource = findArticlesForSource(
                    articleIndex,
                    sourceName,
                    subLink.url,
                  );
                  const articleCount =
                    subLink.article_count ??
                    (articlesForSource.length > 0
                      ? articlesForSource.length
                      : 1);
                  const linkLabel =
                    articleCount > 1
                      ? `${sourceName} (${articleCount})`
                      : sourceName;
                  return (
                    <span key={subLink.article_id}>
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
                      {index < secondaries.length - 1 && (
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
  );
}
