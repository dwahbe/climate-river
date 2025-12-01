import { getRiverData } from '@/lib/services/riverService'

export const revalidate = 300 // Cache for 5 minutes

export async function GET() {
  const baseUrl = 'https://climateriver.org'
  const now = new Date().toUTCString()

  let rssItems = ''

  try {
    const clusters = await getRiverData({
      view: 'top',
      limit: 30,
    })

    rssItems = clusters
      .map((cluster) => {
        const pubDate = new Date(cluster.published_at).toUTCString()
        const description = cluster.lead_dek
          ? escapeXml(cluster.lead_dek)
          : `Coverage from ${cluster.sources_count} source${cluster.sources_count === 1 ? '' : 's'}`

        return `    <item>
      <title>${escapeXml(cluster.lead_title)}</title>
      <link>${baseUrl}/river/${cluster.cluster_id}</link>
      <guid isPermaLink="true">${baseUrl}/river/${cluster.cluster_id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
      <source url="${escapeXml(cluster.lead_homepage || cluster.lead_url)}">${escapeXml(cluster.lead_source || 'Unknown')}</source>
    </item>`
      })
      .join('\n')
  } catch (error) {
    console.error('Error generating RSS feed:', error)
    // Return empty feed on error rather than failing
  }

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Climate River - Top Climate News</title>
    <link>${baseUrl}</link>
    <description>Climate news aggregated from leading outlets like The Guardian, New York Times, and Reuters. Stories organized by topic, ranked for trust and timeliness.</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${baseUrl}/feed.xml" rel="self" type="application/rss+xml"/>
    <ttl>5</ttl>
    <image>
      <url>${baseUrl}/ClimateRiver.png</url>
      <title>Climate River</title>
      <link>${baseUrl}</link>
    </image>
${rssItems}
  </channel>
</rss>`

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  })
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

