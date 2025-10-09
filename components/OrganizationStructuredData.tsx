export default function OrganizationStructuredData() {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Climate River',
    url: 'https://climateriver.org',
    description:
      'Climate River is a curated aggregator of the latest climate news from leading outlets, organized by story and ranked for trust and timeliness.',
    publisher: {
      '@type': 'Organization',
      name: 'Climate River',
      url: 'https://climateriver.org',
      logo: {
        '@type': 'ImageObject',
        url: 'https://climateriver.org/icon.svg',
      },
      founder: {
        '@type': 'Person',
        name: 'Dylan Wahbe',
        url: 'https://dylanwahbe.com',
      },
    },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: 'https://climateriver.org/?q={search_term_string}',
      },
      'query-input': 'required name=search_term_string',
    },
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  )
}
