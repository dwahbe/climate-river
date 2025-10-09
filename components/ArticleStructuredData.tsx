interface ArticleStructuredDataProps {
  headline: string
  description?: string
  datePublished: string
  author?: string
  publisher: string
  url: string
}

export default function ArticleStructuredData({
  headline,
  description,
  datePublished,
  author,
  publisher,
  url,
}: ArticleStructuredDataProps) {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline,
    description: description || headline,
    datePublished,
    author: author
      ? {
          '@type': 'Person',
          name: author,
        }
      : undefined,
    publisher: {
      '@type': 'Organization',
      name: publisher,
      logo: {
        '@type': 'ImageObject',
        url: 'https://climateriver.org/icon.svg',
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': url,
    },
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  )
}
