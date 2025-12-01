interface ArticleStructuredDataProps {
  headline: string
  description?: string
  datePublished: string
  author?: string
  publisher: string
  publisherUrl?: string
  url: string
  articleCount?: number
}

/**
 * Structured data for cluster pages.
 * Uses CollectionPage schema since Climate River aggregates content
 * rather than publishing original articles.
 */
export default function ArticleStructuredData({
  headline,
  description,
  datePublished,
  author,
  publisher,
  publisherUrl,
  url,
  articleCount,
}: ArticleStructuredDataProps) {
  // Build mainEntity, only including author if present
  const mainEntity: Record<string, unknown> = {
    '@type': 'NewsArticle',
    headline,
    publisher: {
      '@type': 'Organization',
      name: publisher,
      ...(publisherUrl && { url: publisherUrl }),
    },
    datePublished,
  }

  if (author) {
    mainEntity.author = {
      '@type': 'Person',
      name: author,
    }
  }

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: headline,
    description:
      description ||
      `Climate news coverage: ${headline}. Aggregated from ${articleCount || 'multiple'} sources.`,
    datePublished,
    dateModified: datePublished,
    url,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Climate River',
      url: 'https://climateriver.org',
    },
    about: {
      '@type': 'Thing',
      name: headline,
    },
    mainEntity,
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  )
}
