import type { Cluster } from '@/lib/models/cluster'

interface ItemListStructuredDataProps {
  clusters: Cluster[]
  listName?: string
}

export default function ItemListStructuredData({
  clusters,
  listName = 'Top Climate News',
}: ItemListStructuredDataProps) {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: listName,
    description:
      'Climate news aggregated from trusted sources, organized by story, ranked for credibility and timeliness.',
    numberOfItems: clusters.length,
    itemListElement: clusters.map((cluster, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: cluster.lead_title,
      url: `https://climateriver.org/river/${cluster.cluster_id}`,
    })),
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  )
}

